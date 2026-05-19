const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { chromium } = require("playwright");

const APARTMENT_URL = process.env.APARTMENT_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const STATE_DIR = ".state";
const STATE_FILE = path.join(STATE_DIR, "last-availability-hash.txt");

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function detectAvailability(pageText) {
  const text = normalizeText(pageText);

  // This is the important line from the page:
  // "0 Boliger matcher din søgning"
  const headingMatch = text.match(/(\d+)\s+boliger?\s+matcher\s+din\s+søgning/i);

  if (headingMatch) {
    const count = Number(headingMatch[1]);

    return {
      available: count > 0,
      count,
      summary: count > 0
        ? `${count} boliger matcher din søgning. Open the link to inspect them.`
        : ""
    };
  }

  // Fallback only if the normal heading is not found.
  const noResults =
    /din søgning gav ikke nogle resultater/i.test(text) ||
    /prøv at ændre på dine søgeparametre/i.test(text);

  if (noResults) {
    return {
      available: false,
      count: 0,
      summary: ""
    };
  }

  return {
    available: false,
    count: 0,
    summary: ""
  };
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
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message.slice(0, 3900),
        disable_web_page_preview: false
      })
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
  if (!APARTMENT_URL) {
    throw new Error("Missing APARTMENT_URL environment variable.");
  }

  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1200 }
    });

    console.log("Opening apartment search page...");

    await page.goto(APARTMENT_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000
    });

    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(5000);

    for (const label of ["Accepter", "Acceptér", "Tillad alle", "OK", "Accept all"]) {
      await page
        .getByRole("button", { name: new RegExp(label, "i") })
        .click({ timeout: 1500 })
        .catch(() => {});
    }

    await page.waitForTimeout(3000);

    const pageText = await page.locator("body").innerText();

    const result = detectAvailability(pageText);

    console.log(`Available: ${result.available}`);
    console.log(`Detected count: ${result.count}`);

    if (!result.available) {
      console.log("No available apartments detected. No Telegram message sent.");
      return;
    }

    fs.mkdirSync(STATE_DIR, { recursive: true });

    const currentHash = hash(`${result.count}\n${result.summary}`);
    const previousHash = fs.existsSync(STATE_FILE)
      ? fs.readFileSync(STATE_FILE, "utf8").trim()
      : "";

    fs.writeFileSync(STATE_FILE, currentHash);

    if (currentHash === previousHash) {
      console.log("Same availability already reported. Not sending duplicate Telegram alert.");
      return;
    }

    const message = [
      "🏠 DAB-Lejerbo alert",
      "",
      `${result.count} available apartment(s) found.`,
      "",
      result.summary,
      "",
      "Link:",
      APARTMENT_URL
    ].join("\n");

    await sendTelegramMessage(message);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});