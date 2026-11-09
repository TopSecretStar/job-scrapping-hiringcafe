# Job Scrapper

A local web app that searches hiringcafe.com for jobs, filters them by location (e.g. "Europe Remote"), and exports CSV/JSON.

It runs **only on your own computer**. Searching opens a real Chromium window here, types your query, scrolls through the results and reads what the page shows, just like a person would. Cloud hosts (Vercel etc.) are blocked by the site's bot protection, and that is not worked around.

## Setup (once)

```powershell
npm install
npx playwright install chromium
```

## Run

```powershell
npm run dev
```

Open http://localhost:3000, type what and where, click **Search**.

- A browser window opens for each search and closes when done (20–90 s).
- If the window shows a Cloudflare "Just a moment…" check, click it once. The browser profile in `.browser-profile/` remembers the clearance, so later searches normally run without it.
- If you use a VPN (e.g. Astrill), turn it off or exclude hiringcafe.com from it: VPN exit addresses are often treated like bots.
- Repeat searches within 10 minutes reuse the previous result, so the site isn't hit again.

## Command line

```powershell
npm run scrape -- "AI Engineer" --location "Europe Remote" --max 100
```

Options: `--workplace remote,hybrid,onsite`, `--no-worldwide`, `--max N`, `--out folder`, `--headless`, `--debug` (saves screenshots, HTML and raw responses to `output/debug/`).

## Environment variables (optional)

| Variable | Purpose |
| --- | --- |
| `HEADLESS=1` | Hide the browser window (a Cloudflare check can then not be clicked). |
| `BROWSER_PROFILE_DIR` | Where the browser profile is stored (default `.browser-profile/`). |
| `HIRINGCAFE_IP` | Fixed IP for hiringcafe.com if your DNS can't resolve it. |

## Be a good visitor

One search at a time, polite delays between page loads, results cached for 10 minutes. Keep it for personal use and don't run it in a loop.
