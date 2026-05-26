const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const DEFAULT_APARTMENT_URL =
  "https://dab-lejerbo.dk/boligsoegende/tidsbegraensede-boliger/";

const APARTMENT_URL = process.env.APARTMENT_URL || DEFAULT_APARTMENT_URL;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const MIN_POSTCODE = Number(process.env.MIN_POSTCODE || 1000);
const MAX_POSTCODE = Number(process.env.MAX_POSTCODE || 2999);

const POSTCODE_TEST = process.env.POSTCODE_TEST === "1";
const FORCE_INITIAL_SNAPSHOT = process.env.FORCE_INITIAL_SNAPSHOT === "1";

const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "seen-housing-ids.json");
const STATE_VERSION = 3;

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function cleanLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => normalizeText(line))
    .filter(Boolean);
}

function isInTargetRange(postcode) {
  return postcode >= MIN_POSTCODE && postcode <= MAX_POSTCODE;
}

/*
  IMPORTANT:
  This is the new strict postcode extractor.

  It only accepts a postcode when it looks like:
    2635 Ishøj Husleje...
    2830 Virum Husleje...
    3460 Birkerød Husleje...
    4700 Næstved Husleje...

  It does NOT accept:
    2026 – 2027
    15-05-2026
    31-10-2027
*/
function extractPostcodeCityAnchors(pageText) {
  const text = normalizeText(pageText);

  const badCityWords = new Set([
    "januar",
    "februar",
    "marts",
    "april",
    "maj",
    "juni",
    "juli",
    "august",
    "september",
    "oktober",
    "november",
    "december",
    "jan",
    "feb",
    "mar",
    "apr",
    "jun",
    "jul",
    "aug",
    "sep",
    "okt",
    "nov",
    "dec",
    "til",
    "until",
    "as",
    "soon",
    "possible",
  ]);

  const cityPattern =
    "[\\p{L}][\\p{L}.'-]*(?:\\s+[\\p{L}][\\p{L}.'-]*){0,3}";

  const rentOrHousingKeyword =
    "(?:Husleje:?|Rent:?|Indskud:?|Deposit:?|Etagebolig|Rækkehus|Apartment|Lejlighed|Bolig|Værelse|Room|FOR RENT|For rent)";

  const postcodeRegex = new RegExp(
    `\\b([1-9]\\d{3})\\s+(${cityPattern})(?=\\s+${rentOrHousingKeyword}\\b)`,
    "giu"
  );

  const anchors = [];
  let match;

  while ((match = postcodeRegex.exec(text)) !== null) {
    const postcode = Number(match[1]);
    const city = normalizeText(match[2]);

    if (postcode < 1000 || postcode > 9999) {
      continue;
    }

    const cityLower = city.toLowerCase();

    if (badCityWords.has(cityLower)) {
      continue;
    }

    const before = text.slice(Math.max(0, match.index - 100), match.index);
    const localContext = text.slice(
      Math.max(0, match.index - 60),
      Math.min(text.length, match.index + 120)
    );

    /*
      Extra guard:
      If the postcode candidate is directly inside rental-period/date text,
      ignore it.
    */
    const looksLikeDateContext =
      /Udlejningsperiode|Rental period|Lejeperiode/i.test(before) &&
      /\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{4}\s*[–-]\s*\d{1,2}|\d{4}\s*(til|to|until)/i.test(
        localContext
      );

    if (looksLikeDateContext) {
      continue;
    }

    anchors.push({
      postcode,
      city,
      index: match.index,
      matchedText: match[0],
    });
  }

  return anchors;
}

function extractAvailablePostcodesFromText(pageText) {
  const anchors = extractPostcodeCityAnchors(pageText);
  const byKey = new Map();

  for (const anchor of anchors) {
    const key = `${anchor.postcode} ${anchor.city}`;

    if (!byKey.has(key)) {
      byKey.set(key, {
        postcode: anchor.postcode,
        city: anchor.city,
        count: 0,
        examples: [],
      });
    }

    const item = byKey.get(key);
    item.count += 1;

    if (item.examples.length < 2) {
      const text = normalizeText(pageText);
      const example = text.slice(anchor.index, anchor.index + 240);
      item.examples.push(example);
    }
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.postcode !== b.postcode) {
      return a.postcode - b.postcode;
    }

    return a.city.localeCompare(b.city, "da");
  });
}

function buildPostcodeTestMessage(postcodeItems) {
  const inRangeItems = postcodeItems.filter((item) => isInTargetRange(item.postcode));

  const lines = [
    "🧪 DAB-Lejerbo postcode extraction test",
    "",
    `Target range: ${MIN_POSTCODE}-${MAX_POSTCODE}`,
    `Strict postcode/city matches found: ${postcodeItems.length}`,
    `Matches inside target range: ${inRangeItems.length}`,
    "",
  ];

  if (postcodeItems.length === 0) {
    lines.push("No strict postcode/city matches found.");
    lines.push("");
    lines.push(
      "This means either the page did not load housing text, or the postcode rule is too strict."
    );
    lines.push("");
    lines.push("Source:");
    lines.push(APARTMENT_URL);
    return lines.join("\n");
  }

  lines.push("Available postcode/city pairs found:");
  lines.push("");

  for (const item of postcodeItems) {
    const marker = isInTargetRange(item.postcode) ? "✅" : "⬜";

    lines.push(`${marker} ${item.postcode} ${item.city} — ${item.count} match(es)`);

    for (const example of item.examples) {
      lines.push(`   Example: ${example}`);
    }

    lines.push("");
  }

  lines.push("Source:");
  lines.push(APARTMENT_URL);

  return lines.join("\n");
}

function shouldSkipText(text) {
  const normalized = normalizeText(text).toLowerCase();

  return [
    "åbningstider",
    "telefontider",
    "hovedkontorer",
    "servicecenter",
    "persondata",
    "cookie",
    "whistleblower",
    "webtilgængelighed",
    "kontaktformular",
    "log ind",
    "botfather",
  ].some((word) => normalized.includes(word));
}

function titleFromText(text) {
  const lines = cleanLines(text);

  const usefulLine =
    lines.find(
      (line) =>
        line.length >= 8 &&
        !shouldSkipText(line) &&
        !/^https?:\/\//i.test(line)
    ) || lines[0];

  return normalizeText(usefulLine || "Matching housing listing").slice(0, 160);
}

function guessListingStart(text, postcodeIndex) {
  const searchStart = Math.max(0, postcodeIndex - 260);
  const before = text.slice(searchStart, postcodeIndex);

  const boundaryPatterns = [
    "Læs mere og se billeder af afdelingen",
    "Read more and see pictures of the department",
    "OBS!",
    "Udlejningsperiode:",
    "Udlejningsperiode",
    "Rental period:",
    "Rental period",
  ];

  let bestLocalIndex = -1;
  let bestBoundary = "";

  for (const boundary of boundaryPatterns) {
    const idx = before.lastIndexOf(boundary);

    if (idx > bestLocalIndex) {
      bestLocalIndex = idx;
      bestBoundary = boundary;
    }
  }

  if (bestLocalIndex >= 0) {
    let absolute = searchStart + bestLocalIndex + bestBoundary.length;

    /*
      After a previous rental period, skip a likely date tail before the next address.
    */
    const tail = text.slice(absolute, postcodeIndex);
    const dateTailMatch = tail.match(
      /(?:\d{1,2}[./-]\d{1,2}[./-]\d{4}|\d{1,2}\.\s*[A-Za-zÆØÅæøå]+\s+\d{4}|\d{4})[^A-Za-zÆØÅæøå]{0,20}/
    );

    if (dateTailMatch && dateTailMatch.index !== undefined) {
      const maybeStart = absolute + dateTailMatch.index + dateTailMatch[0].length;

      if (maybeStart < postcodeIndex) {
        absolute = maybeStart;
      }
    }

    return Math.max(0, absolute);
  }

  /*
    Fallback: start a bit before postcode so the address is included.
  */
  return searchStart;
}

function guessListingEnd(text, nextPostcodeIndex) {
  if (nextPostcodeIndex === -1) {
    const readMore = text.indexOf(
      "Læs mere og se billeder af afdelingen",
      nextPostcodeIndex
    );

    return readMore >= 0 ? readMore : text.length;
  }

  /*
    End before the next listing's address.
  */
  return Math.max(0, nextPostcodeIndex - 180);
}

function extractTitleFromListing(listingText, postcode, city) {
  const normalized = normalizeText(listingText);
  const postcodeCity = `${postcode} ${city}`;
  const idx = normalized.indexOf(postcodeCity);

  if (idx > 0) {
    const beforePostcode = normalized.slice(0, idx).trim();

    const cleaned = beforePostcode
      .replace(/^[-–—.,\s]+/, "")
      .replace(/^(Læs mere og se billeder af afdelingen|Read more and see pictures of the department)\s*/i, "")
      .trim();

    if (cleaned.length >= 5) {
      return `${cleaned.slice(-120)}, ${postcodeCity}`;
    }
  }

  return titleFromText(normalized);
}

function makeListingId(listing) {
  const stablePart = [
    listing.title,
    listing.postcode,
    listing.city,
    normalizeText(listing.text).slice(0, 1200),
    listing.url || APARTMENT_URL,
  ].join("|");

  return hash(stablePart.toLowerCase());
}

function extractListingsFromText(pageText) {
  const text = normalizeText(pageText);
  const anchors = extractPostcodeCityAnchors(text)
    .filter((anchor) => isInTargetRange(anchor.postcode))
    .sort((a, b) => a.index - b.index);

  const rawListings = [];

  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    const nextAnchor = anchors[i + 1];

    const start = guessListingStart(text, anchor.index);
    const end = nextAnchor ? guessListingStart(text, nextAnchor.index) : text.length;

    let listingText = normalizeText(text.slice(start, end));

    /*
      Stop after "Læs mere..." when the next department begins.
    */
    const readMorePatterns = [
      "Læs mere og se billeder af afdelingen",
      "Read more and see pictures of the department",
    ];

    for (const pattern of readMorePatterns) {
      const idx = listingText.indexOf(pattern);

      if (idx > 80) {
        listingText = listingText.slice(0, idx).trim();
      }
    }

    if (!listingText || shouldSkipText(listingText)) {
      continue;
    }

    const title = extractTitleFromListing(
      listingText,
      anchor.postcode,
      anchor.city
    );

    const listing = {
      title,
      text: listingText,
      url: APARTMENT_URL,
      postcode: anchor.postcode,
      city: anchor.city,
      postcodes: [anchor.postcode],
    };

    listing.id = makeListingId(listing);

    rawListings.push(listing);
  }

  /*
    Dedupe by ID.
  */
  const byId = new Map();

  for (const listing of rawListings) {
    const existing = byId.get(listing.id);

    if (!existing || listing.text.length > existing.text.length) {
      byId.set(listing.id, listing);
    }
  }

  return [...byId.values()];
}

async function extractListingsFromPage(page) {
  const bodyText = await page
    .locator("body")
    .innerText({ timeout: 15000 })
    .catch(async () => page.content());

  return extractListingsFromText(bodyText);
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) {
    return {
      seenIds: new Set(),
      hasSentInitialSnapshot: false,
    };
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return {
        seenIds: new Set(parsed),
        hasSentInitialSnapshot: false,
      };
    }

    if (Array.isArray(parsed.seenIds)) {
      return {
        seenIds: new Set(parsed.seenIds),
        hasSentInitialSnapshot:
          parsed.stateVersion === STATE_VERSION &&
          parsed.hasSentInitialSnapshot === true,
      };
    }

    return {
      seenIds: new Set(),
      hasSentInitialSnapshot: false,
    };
  } catch (error) {
    console.warn("Could not read previous state. Starting with empty state.");

    return {
      seenIds: new Set(),
      hasSentInitialSnapshot: false,
    };
  }
}

function saveState(seenIds, hasSentInitialSnapshot) {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const ids = [...seenIds].slice(-2000);

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        stateVersion: STATE_VERSION,
        updatedAt: new Date().toISOString(),
        hasSentInitialSnapshot,
        seenIds: ids,
      },
      null,
      2
    )
  );
}

function buildListingsMessage(title, listings) {
  const lines = [
    title,
    "",
    `Postcode range: ${MIN_POSTCODE}-${MAX_POSTCODE}`,
    `Found: ${listings.length} matching listing(s)`,
    "",
  ];

  listings.forEach((listing, index) => {
    lines.push("━━━━━━━━━━━━━━━━━━━━");
    lines.push(`${index + 1}. ${listing.title}`);
    lines.push(`Postcode: ${listing.postcode} ${listing.city}`);
    lines.push("");

    const shortText = normalizeText(listing.text).slice(0, 1200);

    if (shortText) {
      lines.push(shortText);
      lines.push("");
    }

    if (listing.url) {
      lines.push(`Link: ${listing.url}`);
      lines.push("");
    }
  });

  lines.push("Source:");
  lines.push(APARTMENT_URL);

  return lines.join("\n");
}

function buildEmptyFirstRunMessage() {
  return [
    "✅ DAB-Lejerbo apartment watcher is running",
    "",
    "First snapshot completed.",
    `Postcode range: ${MIN_POSTCODE}-${MAX_POSTCODE}`,
    "",
    "Found 0 matching listings on the page right now.",
    "",
    "This means Telegram works, but the scraper/page did not return any matching apartment details in this run.",
    "",
    "Source:",
    APARTMENT_URL,
  ].join("\n");
}

function splitTelegramMessage(message, maxLength = 3800) {
  if (message.length <= maxLength) {
    return [message];
  }

  const chunks = [];
  let remaining = message;

  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n━━━━━━━━━━━━━━━━━━━━", maxLength);

    if (splitAt < 500) {
      splitAt = remaining.lastIndexOf("\n", maxLength);
    }

    if (splitAt < 500) {
      splitAt = maxLength;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram credentials missing. Would have sent:");
    console.log(message);
    return;
  }

  const chunks = splitTelegramMessage(message);

  for (let i = 0; i < chunks.length; i += 1) {
    const text =
      chunks.length === 1
        ? chunks[i]
        : `${chunks[i]}\n\nPart ${i + 1}/${chunks.length}`;

    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview: false,
        }),
      }
    );

    const result = await response.json();

    if (!response.ok || !result.ok) {
      console.error(result);
      throw new Error("Telegram message failed.");
    }
  }

  console.log(`Telegram message sent in ${chunks.length} part(s).`);
}

async function acceptCookies(page) {
  for (const label of [
    "Accepter",
    "Acceptér",
    "Tillad alle",
    "OK",
    "Accept all",
    "Allow all",
  ]) {
    await page
      .getByRole("button", { name: new RegExp(label, "i") })
      .click({ timeout: 1500 })
      .catch(() => {});
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport: {
        width: 1440,
        height: 1400,
      },
    });

    console.log(`Opening: ${APARTMENT_URL}`);

    await page.goto(APARTMENT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);

    await acceptCookies(page);

    await page.waitForTimeout(3000);

    /*
      Scroll to trigger lazy-loaded content.
    */
    await page.mouse.wheel(0, 2200).catch(() => {});
    await page.waitForTimeout(1500);
    await page.mouse.wheel(0, 2200).catch(() => {});
    await page.waitForTimeout(1500);
    await page.mouse.wheel(0, -4400).catch(() => {});
    await page.waitForTimeout(1500);

    const bodyText = await page
      .locator("body")
      .innerText({ timeout: 15000 })
      .catch(async () => page.content());

    /*
      TEST MODE:
      Sends all available real-looking postcode/city pairs and exits.
      This is what you should run first.
    */
    if (POSTCODE_TEST) {
      console.log("POSTCODE_TEST=1 enabled. Sending postcode-only test.");

      const postcodeItems = extractAvailablePostcodesFromText(bodyText);

      console.log(
        "Strict postcode/city matches:",
        postcodeItems.map((item) => `${item.postcode} ${item.city}`).join(", ")
      );

      await sendTelegramMessage(buildPostcodeTestMessage(postcodeItems));

      return;
    }

    const listings = extractListingsFromText(bodyText);

    console.log(
      `Matching listings in postcode range ${MIN_POSTCODE}-${MAX_POSTCODE}: ${listings.length}`
    );

    const state = loadState();

    const isInitialSnapshot =
      FORCE_INITIAL_SNAPSHOT || state.hasSentInitialSnapshot === false;

    /*
      FIRST RUN:
      Send all listings found in the target postcode range.
      If none are found, still send a Telegram message so we know the bot works.
    */
    if (isInitialSnapshot) {
      console.log("Initial snapshot mode: sending all current matching listings.");

      if (listings.length === 0) {
        await sendTelegramMessage(buildEmptyFirstRunMessage());
        saveState(state.seenIds, true);
        console.log("Saved initial snapshot state with 0 listings.");
        return;
      }

      const message = buildListingsMessage(
        "🏠 Initial DAB-Lejerbo housing snapshot",
        listings
      );

      await sendTelegramMessage(message);

      for (const listing of listings) {
        state.seenIds.add(listing.id);
      }

      saveState(state.seenIds, true);

      console.log(
        `Initial snapshot sent. Saved ${state.seenIds.size} seen listing id(s).`
      );

      return;
    }

    /*
      NEXT RUNS:
      Send only new listings.
    */
    if (listings.length === 0) {
      console.log("No matching listings found. No Telegram message sent.");
      saveState(state.seenIds, true);
      return;
    }

    const newListings = listings.filter((listing) => !state.seenIds.has(listing.id));

    if (newListings.length === 0) {
      console.log("No new matching listings. No Telegram message sent.");
      saveState(state.seenIds, true);
      return;
    }

    console.log(`New listings to alert: ${newListings.length}`);

    const message = buildListingsMessage(
      "🚨 New DAB-Lejerbo housing update",
      newListings
    );

    await sendTelegramMessage(message);

    for (const listing of listings) {
      state.seenIds.add(listing.id);
    }

    saveState(state.seenIds, true);

    console.log(`Saved ${state.seenIds.size} seen listing id(s).`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});