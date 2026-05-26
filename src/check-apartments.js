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
const MAX_POSTCODE = Number(process.env.MAX_POSTCODE || 3999);

const FORCE_INITIAL_SNAPSHOT = process.env.FORCE_INITIAL_SNAPSHOT === "1";

const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "seen-housing-ids.json");
const STATE_VERSION = 2;

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

function extractPostcodes(text) {
  const matches = [];
  const regex = /(?:^|\D)(\d{4})(?=\D|$)/g;
  let match;

  while ((match = regex.exec(String(text || ""))) !== null) {
    const postcode = Number(match[1]);

    if (postcode >= MIN_POSTCODE && postcode <= MAX_POSTCODE) {
      matches.push(postcode);
    }
  }

  return [...new Set(matches)];
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

  return normalizeText(usefulLine || "Matching housing listing").slice(0, 140);
}

function makeListingId(listing) {
  /*
    Do NOT use only URL + postcode.
    Multiple apartments can appear on the same generic DAB-Lejerbo page.
    This ID uses the title, postcode, listing text, and URL.
  */
  const stablePart = [
    listing.title,
    listing.postcodes.join(","),
    normalizeText(listing.text).slice(0, 1500),
    listing.url || APARTMENT_URL,
  ].join("|");

  return hash(stablePart.toLowerCase());
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

    /*
      Old state files from your previous script only had seen IDs.
      We intentionally treat old state as NOT initialized,
      so your next run sends the full first snapshot.
    */
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

function dedupeListings(rawListings) {
  const byId = new Map();

  for (const raw of rawListings) {
    const text = normalizeText(raw.text);
    const postcodes = extractPostcodes(text);

    if (!text || postcodes.length === 0 || shouldSkipText(text)) {
      continue;
    }

    const listing = {
      title: titleFromText(raw.title || text),
      text,
      url: raw.url || APARTMENT_URL,
      postcodes,
    };

    listing.id = makeListingId(listing);

    const existing = byId.get(listing.id);

    if (!existing || listing.text.length > existing.text.length) {
      byId.set(listing.id, listing);
    }
  }

  return [...byId.values()];
}

async function extractListingsFromPage(page) {
  const rawListings = await page.evaluate(
    ({ minPostcode, maxPostcode }) => {
      function normalize(value) {
        return String(value || "").replace(/\s+/g, " ").trim();
      }

      function hasMatchingPostcode(text) {
        const regex = /(?:^|\D)(\d{4})(?=\D|$)/g;
        let match;

        while ((match = regex.exec(String(text || ""))) !== null) {
          const postcode = Number(match[1]);

          if (postcode >= minPostcode && postcode <= maxPostcode) {
            return true;
          }
        }

        return false;
      }

      function looksLikeHousingText(text) {
        const value = normalize(text).toLowerCase();

        if (value.length < 20 || value.length > 8000) {
          return false;
        }

        if (!hasMatchingPostcode(value)) {
          return false;
        }

        return /bolig|lejemål|lejlighed|værelse|rum|m2|m²|kvm|husleje|leje|kr\.?|kroner|indskud|depositum|overtagelse|adresse|tidsbegrænset|tidsbegraenset|fleksible regler|udlejning|for rent/i.test(
          value
        );
      }

      function nearestUsefulNode(node) {
        return (
          node.closest(
            "article, li, [class*='card'], [class*='result'], [class*='bolig'], [class*='apartment'], [class*='property'], [class*='teaser'], [class*='item'], [class*='listing'], section"
          ) || node
        );
      }

      const root = document.querySelector("main") || document.body;

      const nodes = [
        ...root.querySelectorAll("article, li, a[href], div, section, [class]"),
      ];

      const results = [];

      for (const node of nodes) {
        if (node.closest("header, footer, nav")) {
          continue;
        }

        const usefulNode = nearestUsefulNode(node);
        const text = normalize(usefulNode.innerText || usefulNode.textContent);

        if (!looksLikeHousingText(text)) {
          continue;
        }

        const anchor = usefulNode.matches("a[href]")
          ? usefulNode
          : usefulNode.querySelector("a[href]");

        const href = anchor ? anchor.getAttribute("href") : "";
        const url = href ? new URL(href, window.location.href).href : "";

        results.push({
          title: normalize(anchor?.innerText || ""),
          text,
          url,
        });
      }

      /*
        Fallback:
        If the page text contains a postcode but the DOM card selector failed,
        create rough snippets around postcode matches.
      */
      if (results.length === 0) {
        const bodyText = normalize(document.body.innerText || document.body.textContent);
        const regex = /(?:^|\D)(\d{4})(?=\D|$)/g;
        let match;

        while ((match = regex.exec(bodyText)) !== null) {
          const postcode = Number(match[1]);

          if (postcode < minPostcode || postcode > maxPostcode) {
            continue;
          }

          const start = Math.max(0, match.index - 700);
          const end = Math.min(bodyText.length, match.index + 1400);
          const snippet = normalize(bodyText.slice(start, end));

          if (looksLikeHousingText(snippet)) {
            results.push({
              title: snippet.slice(0, 120),
              text: snippet,
              url: window.location.href,
            });
          }
        }
      }

      return results;
    },
    {
      minPostcode: MIN_POSTCODE,
      maxPostcode: MAX_POSTCODE,
    }
  );

  return dedupeListings(rawListings);
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
    lines.push(`━━━━━━━━━━━━━━━━━━━━`);
    lines.push(`${index + 1}. ${listing.title}`);
    lines.push(`Postcode(s): ${listing.postcodes.join(", ")}`);
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
    `First snapshot completed.`,
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

    await page.waitForTimeout(3000);

    /*
      Scroll down and up to trigger lazy-loaded content.
    */
    await page.mouse.wheel(0, 1800).catch(() => {});
    await page.waitForTimeout(1500);
    await page.mouse.wheel(0, -1800).catch(() => {});
    await page.waitForTimeout(1500);

    const listings = await extractListingsFromPage(page);

    console.log(
      `Matching listings in postcode range ${MIN_POSTCODE}-${MAX_POSTCODE}: ${listings.length}`
    );

    const state = loadState();

    const isInitialSnapshot =
      FORCE_INITIAL_SNAPSHOT || state.hasSentInitialSnapshot === false;

    /*
      FIRST RUN:
      Send everything found.
      If nothing is found, still send a Telegram message so you know the bot works.
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
      Only send listings that were not seen before.
    */
    if (listings.length === 0) {
      console.log("No matching listings found. No Telegram message sent.");
      saveState(state.seenIds, true);
      return;
    }

    const newListings = listings.filter((listing) => !state.seenIds.has(listing.id));

    if (newListings.length === 0) {
      console.log("No new matching listings. No Telegram message sent.");

      /*
        Save current state again, keeping the new state format.
      */
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