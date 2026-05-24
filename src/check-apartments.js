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

const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "seen-housing-ids.json");

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
  const stablePart = listing.url
    ? `${listing.url}|${listing.postcodes.join(",")}`
    : `${listing.title}|${listing.postcodes.join(",")}|${listing.text}`;

  return hash(stablePart);
}

function loadSeenIds() {
  if (!fs.existsSync(STATE_FILE)) {
    return new Set();
  }

  try {
    const raw = fs.readFileSync(STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);

    if (Array.isArray(parsed)) {
      return new Set(parsed);
    }

    if (Array.isArray(parsed.seenIds)) {
      return new Set(parsed.seenIds);
    }

    return new Set();
  } catch (error) {
    console.warn("Could not read previous state. Starting with empty state.");
    return new Set();
  }
}

function saveSeenIds(seenIds) {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  const ids = [...seenIds].slice(-1000);

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        seenIds: ids,
      },
      null,
      2
    )
  );
}

function dedupeListings(rawListings) {
  const byKey = new Map();

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

    const key = listing.url
      ? `${listing.url}|${listing.postcodes.join(",")}`.toLowerCase()
      : `${listing.title}|${listing.postcodes.join(",")}`.toLowerCase();

    const existing = byKey.get(key);

    if (!existing || listing.text.length > existing.text.length) {
      listing.id = makeListingId(listing);
      byKey.set(key, listing);
    }
  }

  return [...byKey.values()];
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

        if (value.length < 20 || value.length > 2500) {
          return false;
        }

        if (!hasMatchingPostcode(value)) {
          return false;
        }

        return /bolig|lejemål|lejlighed|værelse|rum|m2|m²|husleje|kr\.?|indskud|overtagelse|adresse|tidsbegrænset/i.test(
          value
        );
      }

      function nearestUsefulNode(node) {
        return (
          node.closest(
            "article, li, [class*='card'], [class*='result'], [class*='bolig'], [class*='apartment'], [class*='property'], [class*='teaser'], [class*='item'], [class*='listing']"
          ) || node
        );
      }

      const root = document.querySelector("main") || document.body;

      const nodes = [
        ...root.querySelectorAll(
          "article, li, a[href], div, section, [class]"
        ),
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

        const anchor =
          usefulNode.matches("a[href]")
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

      return results;
    },
    {
      minPostcode: MIN_POSTCODE,
      maxPostcode: MAX_POSTCODE,
    }
  );

  return dedupeListings(rawListings);
}

function buildTelegramMessage(newListings) {
  const lines = [
    "🏠 New DAB-Lejerbo housing match",
    "",
    `Found ${newListings.length} new matching listing(s) in postcode range ${MIN_POSTCODE}-${MAX_POSTCODE}.`,
    "",
  ];

  newListings.slice(0, 10).forEach((listing, index) => {
    lines.push(`${index + 1}. ${listing.title}`);
    lines.push(`Postcode(s): ${listing.postcodes.join(", ")}`);

    const shortText = normalizeText(listing.text).slice(0, 350);
    if (shortText) {
      lines.push(shortText);
    }

    if (listing.url) {
      lines.push(listing.url);
    }

    lines.push("");
  });

  if (newListings.length > 10) {
    lines.push(`And ${newListings.length - 10} more matching listing(s).`);
    lines.push("");
  }

  lines.push("Source:");
  lines.push(APARTMENT_URL);

  return lines.join("\n");
}

async function sendTelegramMessage(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log("Telegram credentials missing. Would have sent:");
    console.log(message);
    return;
  }

  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message.slice(0, 3900),
        disable_web_page_preview: false,
      }),
    }
  );

  const result = await response.json();

  if (!response.ok || !result.ok) {
    console.error(result);
    throw new Error("Telegram message failed.");
  }

  console.log("Telegram message sent.");
}

async function main() {
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport: {
        width: 1440,
        height: 1200,
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
    ]) {
      await page
        .getByRole("button", { name: new RegExp(label, "i") })
        .click({ timeout: 1500 })
        .catch(() => {});
    }

    await page.waitForTimeout(3000);

    const listings = await extractListingsFromPage(page);

    console.log(
      `Matching listings in postcode range ${MIN_POSTCODE}-${MAX_POSTCODE}: ${listings.length}`
    );

    if (listings.length === 0) {
      console.log("No matching listings found. No Telegram message sent.");
      return;
    }

    const seenIds = loadSeenIds();

    if (seenIds.size === 0) {
      for (const listing of listings) {
        seenIds.add(listing.id);
      }

      saveSeenIds(seenIds);

      console.log(
        "First run with this state file. Saved existing matching listings without sending Telegram message."
      );

      return;
    }

    const newListings = listings.filter((listing) => !seenIds.has(listing.id));

    if (newListings.length === 0) {
      console.log("No new matching listings. No Telegram message sent.");
      return;
    }

    const message = buildTelegramMessage(newListings);
    await sendTelegramMessage(message);

    for (const listing of listings) {
      seenIds.add(listing.id);
    }

    saveSeenIds(seenIds);

    console.log(`Saved ${seenIds.size} seen listing id(s).`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});