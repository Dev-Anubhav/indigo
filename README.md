# IndiGo PNR Bulk Scraper

Automated bulk PNR booking detail extractor for IndiGo flights.
Reads from Excel → processes each PNR → exports results to Excel.
Uses router restart for IP rotation to avoid blocking.

## One-Click Desktop App (Client Friendly)

For non-technical users on macOS:

1. Double-click [Open Airline Data Extractor.command](/Users/user/Downloads/indigo-scraper-v2/Open Airline Data Extractor.command)
2. A desktop app window opens (no browser steps needed)
3. Keep Terminal open while the app is running

Alternative from terminal:

```bash
npm run desktop
```

---

## Folder Structure

```
indigo-scraper/
├── data/
│   ├── input.xlsx       ← Your input file goes here
│   └── jobs.db          ← SQLite database (auto-created)
├── output/
│   └── results.xlsx     ← Generated output file
├── logs/
│   └── scraper.log      ← Full run log
├── src/
│   ├── index.js         ← Main orchestrator
│   ├── scraper.js       ← Playwright browser automation
│   ├── rotator.js       ← Router restart IP rotation
│   ├── db.js            ← SQLite queue manager
│   ├── import.js        ← Excel → database importer
│   ├── export.js        ← Database → Excel exporter
│   ├── status.js        ← Live progress checker
│   └── resetFailed.js   ← Reset failed jobs for retry
├── .env                 ← Your configuration
└── package.json
```

---

## Step 1 — Install

```bash
# Install Node.js dependencies
npm install

# Install Playwright browser
npx playwright install chromium
```

---

## Step 2 — Configure .env

Open `.env` and set your router details:

```env
ROUTER_IP=192.168.1.1        # Your router's IP address
ROUTER_USERNAME=admin         # Router admin username
ROUTER_PASSWORD=admin         # Router admin password
ROUTER_BRAND=tplink           # tplink | dlink | netgear | asus | jiofiber | airtel | generic
```

### How to find your router IP:
- **Windows**: Open CMD → type `ipconfig` → look for "Default Gateway"
- **Mac/Linux**: Open Terminal → type `ip route` or `netstat -nr`
- Common values: `192.168.1.1`, `192.168.0.1`, `192.168.29.1` (JioFiber)

### How to find router brand:
Check the label on the back of your router.

---

## Step 3 — Prepare Input Excel

Your Excel file (`data/input.xlsx`) must have:
- Column A: PNR / Booking Reference
- Column B: Last Name

**OR** any column order — the importer auto-detects columns named "PNR", "Booking", "Last Name", "Surname", etc.

Example:
| PNR    | Last Name |
|--------|-----------|
| ABC123 | SHARMA    |
| XYZ456 | GUPTA     |

---

## Step 4 — Import your Excel

```bash
npm run import
```

This reads your Excel and loads all PNRs into the job queue.
Safe to run multiple times — won't create duplicates.

---

## Step 5 — Run the scraper

```bash
npm start
```

The scraper will:
1. Process records one by one with human-like delays
2. Save results immediately to the database after each record
3. Restart your router every 40 records (configurable in .env)
4. Resume automatically if stopped — won't re-process completed records

**To watch it work (non-headless mode):**
Set `HEADLESS=false` in `.env` before running.

---

## Step 6 — Export results

```bash
npm run export
```

Generates `output/results.xlsx` with three sheets:
- **Results** — all successfully extracted booking details
- **Failed Records** — PNRs that couldn't be retrieved
- **Summary** — stats overview

---

## Useful Commands

```bash
# Check progress anytime (doesn't interrupt the scraper)
npm run status

# If scraper was stopped, just run npm start again — it resumes
npm start

# After a run, reset all failed jobs to try again
npm run reset-failed
npm start
```

---

## Tuning for your situation

In `.env`:

```env
BATCH_SIZE=40         # Lower (20-30) = safer, fewer blocks. Higher (50-60) = faster, more risk
MIN_DELAY_MS=10000    # Minimum wait between requests (10s recommended minimum)
MAX_DELAY_MS=22000    # Maximum wait between requests
HEADLESS=true         # false = visible browser (useful for debugging)
```

**Recommended settings by risk tolerance:**

| Priority    | BATCH_SIZE | MIN_DELAY | MAX_DELAY | Records/day |
|-------------|------------|-----------|-----------|-------------|
| Safe        | 25         | 12000     | 25000     | ~2,500      |
| Balanced    | 40         | 10000     | 20000     | ~3,500      |
| Faster      | 50         | 8000      | 15000     | ~5,000      |

---

## Troubleshooting

**Router restart not working:**
1. Open your router admin panel in browser: `http://192.168.1.1`
2. Verify username/password work manually
3. Try `ROUTER_BRAND=generic` which tries multiple endpoints
4. As fallback: manually unplug router during IP rotation pauses

**Scraper can't find form fields:**
IndiGo may have updated their page. Set `HEADLESS=false` and watch what happens.
The form selectors in `src/scraper.js` may need updating.

**IP not changing after restart:**
Some ISPs assign sticky IPs. Test manually:
1. Check your IP at https://api.ipify.org
2. Restart router
3. Check IP again
If same → your ISP uses sticky IPs. Consider Android ADB hotspot method instead.

**High failure rate:**
- Increase `MIN_DELAY_MS` to 15000+
- Decrease `BATCH_SIZE` to 20
- Run during off-peak hours (11pm–5am IST)
