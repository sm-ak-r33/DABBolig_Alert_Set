# DAB-Lejerbo Apartment Watcher

A small GitHub Actions automation that checks a saved DAB-Lejerbo apartment search link and sends a Telegram alert when available apartments are detected.

The watcher is designed for the DAB-Lejerbo search page:

```text
https://dab-lejerbo.dk/boligsoegende/find-en-bolig/...
```

It runs automatically between **09:00 and 11:30 Europe/Copenhagen time** and can also be triggered manually from the GitHub Actions tab.

---

## What it does

- Opens the DAB-Lejerbo apartment search page with Playwright.
- Waits for the dynamic apartment listing content to load.
- Looks for availability-related Danish text such as `ledige boliger`, prices, deposits, rooms, and area information.
- Sends a Telegram message when possible available apartments are found.
- Avoids sending duplicate alerts for the same result by storing a small state file through GitHub Actions cache.

---

## Project structure

```text
.
├── .github/
│   └── workflows/
│       └── apartment-watch.yml
├── src/
│   └── check-apartments.js
├── package.json
├── package-lock.json
└── README.md
```

---

## Required GitHub Secrets

Add these in:

**Repository → Settings → Secrets and variables → Actions → New repository secret**

| Secret name | Description |
|---|---|
| `APARTMENT_URL` | The full DAB-Lejerbo search URL to monitor. |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token from BotFather. |
| `TELEGRAM_CHAT_ID` | Telegram chat ID where alerts should be sent. |

---

## How to create the Telegram bot

1. Open Telegram.
2. Search for `@BotFather`.
3. Send:

```text
/newbot
```

4. Follow the instructions and copy the bot token.
5. Open your new bot and send:

```text
/start
```

6. Get your chat ID by opening this URL in a browser, replacing `YOUR_BOT_TOKEN`:

```text
https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
```

Look for a value like this:

```json
"chat": {
  "id": 123456789
}
```

Use that number as `TELEGRAM_CHAT_ID`.

---

## Local setup

Install dependencies:

```bash
npm install
npx playwright install chromium
```

Run locally with environment variables.

### PowerShell

```powershell
$env:APARTMENT_URL="PASTE_FULL_DAB_LEJERBO_URL_HERE"
$env:TELEGRAM_BOT_TOKEN="PASTE_TELEGRAM_BOT_TOKEN_HERE"
$env:TELEGRAM_CHAT_ID="PASTE_TELEGRAM_CHAT_ID_HERE"
npm run check
```

### Bash / Git Bash

```bash
export APARTMENT_URL="PASTE_FULL_DAB_LEJERBO_URL_HERE"
export TELEGRAM_BOT_TOKEN="PASTE_TELEGRAM_BOT_TOKEN_HERE"
export TELEGRAM_CHAT_ID="PASTE_TELEGRAM_CHAT_ID_HERE"
npm run check
```

---

## GitHub Actions schedule

The workflow is configured to run between **09:05 and 11:20 Europe/Copenhagen time**:

```yaml
schedule:
  - cron: "5/15 9-10 * * *"
    timezone: "Europe/Copenhagen"
  - cron: "5,20 11 * * *"
    timezone: "Europe/Copenhagen"
```

This gives checks at approximately:

```text
09:05, 09:20, 09:35, 09:50
10:05, 10:20, 10:35, 10:50
11:05, 11:20
```

The workflow can also be run manually from:

**GitHub → Actions → Apartment Watch → Run workflow**

---

## Expected log messages

When the workflow runs, check the GitHub Actions logs.

If no apartment is found:

```text
No available apartments detected.
```

If an apartment is found and Telegram is configured correctly:

```text
Telegram message sent.
```

If an apartment is found but it has already been reported:

```text
Same availability already reported. Not sending duplicate Telegram alert.
```

---

## Troubleshooting

### The workflow ran but I got no Telegram message

Check the logs. The most likely reason is that no available apartments were detected.

### Telegram credentials missing

Make sure these GitHub Secrets exist and are spelled exactly like this:

```text
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

### APARTMENT_URL is missing

Make sure this GitHub Secret exists:

```text
APARTMENT_URL
```

The value should be the full DAB-Lejerbo search link.

### Telegram message failed

Common causes:

- The bot token is wrong.
- The chat ID is wrong.
- You have not sent `/start` to the bot yet.
- The bot was blocked or deleted.

### The page layout changed

The script uses text-based detection because the DAB-Lejerbo page is dynamic. If the site changes its wording or layout, update the selectors and detection logic in:

```text
src/check-apartments.js
```

---

## Updating the monitored search

To change the apartment search filters, create a new DAB-Lejerbo search URL in the browser and update the `APARTMENT_URL` GitHub Secret.

You do not need to change the code when only the search URL changes.

---

## Security notes

Do not commit your Telegram bot token or chat ID directly into the repository.

Use GitHub Actions Secrets for private values.

---

## Useful commands

Commit the README:

```bash
git add README.md
git commit -m "Add README for apartment watcher"
git push
```

Run the watcher locally:

```bash
npm run check
```
