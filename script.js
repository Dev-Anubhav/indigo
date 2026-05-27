const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

(async () => {
  const outDir = path.join(process.cwd(), "logs");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  const logFile = path.join(outDir, `session-${Date.now()}.jsonl`);
  const harFile = path.join(outDir, `session-${Date.now()}.har`);

  const logStream = fs.createWriteStream(logFile, { flags: "a" });

  console.log("🚀 Starting browser...");

  const browser = await chromium.launch({
    headless: false,
    args: ["--disable-blink-features=AutomationControlled"],
  });

  const context = await browser.newContext({
    recordHar: {
      path: harFile,
      content: "embed",
    },
  });

  const page = await context.newPage();

  // ─── REQUEST CAPTURE ─────────────────────────────
  page.on("request", async (request) => {
    try {
      const postData = request.postData();

      const entry = {
        type: "request",
        time: new Date().toISOString(),
        url: request.url(),
        method: request.method(),
        headers: request.headers(),
        postData: postData ? postData.slice(0, 5000) : null, // limit size
      };

      logStream.write(JSON.stringify(entry) + "\n");
    } catch (e) {}
  });

  // ─── RESPONSE CAPTURE ────────────────────────────
  page.on("response", async (response) => {
    try {
      const request = response.request();

      let body = null;
      try {
        const buffer = await response.body();
        body = buffer.toString("utf8").slice(0, 5000); // limit
      } catch {}

      const entry = {
        type: "response",
        time: new Date().toISOString(),
        url: response.url(),
        status: response.status(),
        headers: response.headers(),
        method: request.method(),
        body,
      };

      logStream.write(JSON.stringify(entry) + "\n");
    } catch (e) {}
  });

  // ─── CONSOLE LOGS (optional but useful) ─────────
  page.on("console", (msg) => {
    const entry = {
      type: "console",
      time: new Date().toISOString(),
      text: msg.text(),
    };
    logStream.write(JSON.stringify(entry) + "\n");
  });

  // ─── OPEN SITE ──────────────────────────────────
  console.log("🌐 Opening site...");
  await page.goto(
    "https://www.goindigo.in/account/my-bookings.html?linkNav=Find%20%26%20view%20booking%7CMy%20trips%7CTrips"
  );

  console.log(`
👉 Now do everything manually:
   - Enter PNR
   - Click buttons
   - Initiate refund

Logs are being saved to:
${logFile}

Press CTRL + C when done.
  `);

  // Keep running indefinitely
  await new Promise(() => {});
})();
