const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const DEFAULT_WAITLY_URL =
  "https://waitly.eu/da/soegning?search=Copenhagen,+Danmark&address=d52cbf2048515d4feeac41b96c9e926390ab4f8d3fb4e0b10088c218b87926a180db958f167b69f899b6e68616b10389&type=rental_housing";

const WAITLY_URL =
  process.env.WAITLY_URL || process.env.APARTMENT_URL || DEFAULT_WAITLY_URL;

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "seen-waitly-ids.json");

const HEADLESS = String(process.env.HEADLESS || "true").toLowerCase() !== "false";
const MAX_ALERT_ITEMS = Number(process.env.MAX_ALERT_ITEMS || 10);
const ALERT_ON_FIRST_RUN =
  String(process.env.ALERT_ON_FIRST_RUN || "false").toLowerCase() === "true";

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

function shouldSkipText(text) {
  const value = normalizeText(text).toLowerCase();

  return [
    "privatlivspolitik",
    "handelsbetingelser",
    "underdatabehandlere",
    "sitemap",
    "karriere",
    "hjælpecenter",
    "faq til",
    "kontakt",
    "login",
    "generelt",
    "erhverv",
    "se vores lister",
    "se mere",
    "waitly+",
    "cookies",
    "cookie",
  ].some((word) => value.includes(word));
}

function titleFromText(text) {
  const lines = cleanLines(text);

  const usefulLine =
    lines.find((line) => {
      const value = line.toLowerCase();

      if (line.length < 3) return false;
      if (line.length > 140) return false;
      if (shouldSkipText(line)) return false;
      if (/^(se detaljer|få besked|tilbage til liste)$/i.test(line)) return false;
      if (/^\d+$/.test(line)) return false;

      return (
        /københavn|copenhagen|frederiksberg|nordvest|nordhavn|sydhavn|valby|bispebjerg|østerbro|lejebolig|andelsbolig|ejendom|nyhedsbrev/i.test(
          value
        ) || /\b\d{4}\b/.test(value)
      );
    }) || lines.find((line) => !shouldSkipText(line)) || "Waitly housing result";

  return normalizeText(usefulLine).slice(0, 140);
}

function makeListingId(listing) {
  const stablePart = [
    listing.url || "",
    listing.title || "",
    listing.location || "",
    listing.text || "",
  ].join("|");

  return hash(stablePart.toLowerCase());
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
    console.warn("Could not read previous Waitly state. Starting with empty state.");
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
        source: WAITLY_URL,
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
    const url = normalizeText(raw.url);
    const title = titleFromText(raw.title || text);

    if (!text) continue;
    if (shouldSkipText(text)) continue;

    const listing = {
      title,
      text,
      url: url || WAITLY_URL,
      location: normalizeText(raw.location),
    };

    listing.id = makeListingId(listing);

    const key = `${listing.url}|${listing.title}`.toLowerCase();
    const existing = byKey.get(key);

    if (!existing || listing.text.length > existing.text.length) {
      byKey.set(key, listing);
    }
  }

  return [...byKey.values()];
}

async function acceptCookies(page) {
  const labels = [
    "Accepter",
    "Acceptér",
    "Tillad alle",
    "Accept all",
    "Allow all",
    "OK",
  ];

  for (const label of labels) {
    await page
      .getByRole("button", { name: new RegExp(label, "i") })
      .click({ timeout: 1500 })
      .catch(() => {});
  }
}

async function extractListingsFromPage(page) {
  const rawListings = await page.evaluate(() => {
    function normalize(value) {
      return String(value || "").replace(/\s+/g, " ").trim();
    }

    function isVisible(element) {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      return (
        style &&
        style.visibility !== "hidden" &&
        style.display !== "none" &&
        rect.width > 0 &&
        rect.height > 0
      );
    }

    function looksLikeWaitlyResult(text) {
      const value = normalize(text).toLowerCase();

      if (value.length < 10 || value.length > 1800) {
        return false;
      }

      if (
        /privatlivspolitik|handelsbetingelser|underdatabehandlere|sitemap|karriere|hjælpecenter|faq til|kontakt|login|generelt|erhverv/.test(
          value
        )
      ) {
        return false;
      }

      const hasAction =
        /se detaljer|få besked|skriv dig|sign up|tilmeld/i.test(value);

      const hasHousingSignal =
        /ejendomme|ejendom|nyhedsbrev|nyhedsbreve|bolig|lejebolig|andelsbolig|rental|housing|københavn|copenhagen|frederiksberg|nordvest|nordhavn|sydhavn|valby|bispebjerg|østerbro|\b\d{4}\b/i.test(
          value
        );

      return hasAction && hasHousingSignal;
    }

    function nearestUsefulNode(node) {
      return (
        node.closest(
          [
            "article",
            "li",
            "[class*='card']",
            "[class*='Card']",
            "[class*='result']",
            "[class*='Result']",
            "[class*='item']",
            "[class*='Item']",
            "[data-testid*='card']",
            "[data-testid*='result']",
          ].join(", ")
        ) || node
      );
    }

    const root = document.querySelector("main") || document.body;

    const nodes = [
      ...root.querySelectorAll(
        [
          "article",
          "li",
          "section",
          "div",
          "a[href]",
          "[class]",
          "[data-testid]",
        ].join(", ")
      ),
    ];

    const results = [];

    for (const node of nodes) {
      if (!isVisible(node)) continue;
      if (node.closest("header, footer, nav")) continue;

      const usefulNode = nearestUsefulNode(node);
      if (!isVisible(usefulNode)) continue;

      const text = normalize(usefulNode.innerText || usefulNode.textContent);
      if (!looksLikeWaitlyResult(text)) continue;

      const heading = usefulNode.querySelector("h1, h2, h3, h4");
      const anchors = [...usefulNode.querySelectorAll("a[href]")];

      const preferredAnchor =
        anchors.find((anchor) =>
          /se detaljer|få besked|katalog|area_interest|lejebolig|andelsbolig/i.test(
            `${anchor.innerText || ""} ${anchor.href || ""}`
          )
        ) || anchors[0];

      const href = preferredAnchor ? preferredAnchor.getAttribute("href") : "";
      const url = href ? new URL(href, window.location.href).href : window.location.href;

      const title = normalize(
        heading?.innerText ||
          preferredAnchor?.innerText ||
          text.split("\n").find(Boolean) ||
          "Waitly housing result"
      );

      const location =
        normalize(
          usefulNode.querySelector("[class*='location'], [class*='Location']")?.innerText
        ) || "";

      results.push({
        title,
        text,
        location,
        url,
      });
    }

    return results;
  });

  return dedupeListings(rawListings);
}

function buildTelegramMessage(newListings) {
  const lines = [
    "New Waitly housing result",
    "",
    `Found ${newListings.length} new Waitly result(s).`,
    "",
  ];

  newListings.slice(0, MAX_ALERT_ITEMS).forEach((listing, index) => {
    lines.push(`${index + 1}. ${listing.title}`);

    if (listing.location) {
      lines.push(`Location: ${listing.location}`);
    }

    const shortText = normalizeText(listing.text).slice(0, 450);
    if (shortText) {
      lines.push(shortText);
    }

    if (listing.url) {
      lines.push(listing.url);
    }

    lines.push("");
  });

  if (newListings.length > MAX_ALERT_ITEMS) {
    lines.push(`And ${newListings.length - MAX_ALERT_ITEMS} more result(s).`);
    lines.push("");
  }

  lines.push("Source:");
  lines.push(WAITLY_URL);

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
  const browser = await chromium.launch({ headless: HEADLESS });

  try {
    const page = await browser.newPage({
      viewport: {
        width: 1440,
        height: 1200,
      },
      locale: "da-DK",
    });

    console.log(`Opening Waitly URL: ${WAITLY_URL}`);

    await page.goto(WAITLY_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await acceptCookies(page);
    await page.waitForTimeout(5000);

    const listings = await extractListingsFromPage(page);

    console.log(`Waitly matching results found: ${listings.length}`);

    if (listings.length === 0) {
      console.log("No Waitly results detected. No Telegram message sent.");
      return;
    }

    const seenIds = loadSeenIds();

    if (seenIds.size === 0 && !ALERT_ON_FIRST_RUN) {
      for (const listing of listings) {
        seenIds.add(listing.id);
      }

      saveSeenIds(seenIds);

      console.log(
        "First run with this Waitly state file. Saved existing results without sending Telegram message."
      );
      return;
    }

    const newListings = listings.filter((listing) => !seenIds.has(listing.id));

    if (newListings.length === 0) {
      console.log("No new Waitly results. No Telegram message sent.");
      return;
    }

    const message = buildTelegramMessage(newListings);
    await sendTelegramMessage(message);

    for (const listing of listings) {
      seenIds.add(listing.id);
    }

    saveSeenIds(seenIds);

    console.log(`Saved ${seenIds.size} seen Waitly result id(s).`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
