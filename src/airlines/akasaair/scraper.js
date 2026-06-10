"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const MANAGE_BOOKING_URL = "https://www.akasaair.com/manage-booking";
const API_HINT = "/api/ibe/booking";
const HEADLESS =
  String(process.env.HEADLESS || "false").toLowerCase() !== "false";

let browser = null;
let context = null;
let page = null;
const USER_DATA_DIR = path.resolve(
  process.env.AKASAAIR_USER_DATA_DIR || "./data/chrome-akasaair-profile"
);

function logDir() {
  const dir = path.resolve(
    process.env.LOG_PATH ? path.dirname(process.env.LOG_PATH) : "./logs"
  );
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function splitIsoDateTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return { date: "", time: "" };
  const dt = new Date(raw);
  if (!Number.isNaN(dt.getTime())) {
    const iso = dt.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
  if (m) return { date: m[1], time: m[2] };
  return { date: raw.slice(0, 10), time: "" };
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeResponsePayload(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

async function readInlinePageError(pageRef) {
  try {
    const text = await pageRef.evaluate(() => {
      const clean = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();
      const selectors = [
        ".MuiFormHelperText-root",
        ".error-message",
        ".toast-message",
        ".snackbar-message",
        ".MuiAlert-message",
        "[class*='error']",
        "[class*='alert']",
        "[class*='warning']"
      ];
      const parts = [];
      for (const selector of selectors) {
        for (const node of document.querySelectorAll(selector)) {
          const text = clean(node.textContent);
          if (text) parts.push(text);
        }
      }
      return parts.join(" | ");
    });
    return String(text || "").trim();
  } catch (_) {
    return "";
  }
}

async function waitForAkasaApiPayload(pageRef, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      pageRef.off("response", onResponse);
    };

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    };

    const onResponse = async (resp) => {
      const url = resp.url();
      if (!url.includes(API_HINT)) return;
      try {
        const status = resp.status();
        if (status !== 200) return;
        const bodyText = await resp.text();
        const payload = normalizeResponsePayload(bodyText);
        if (payload && payload.data && payload.data.recordLocator) {
          finish(null, {
            status,
            url,
            bodyText,
            payload,
          });
        }
      } catch (err) {
        // ignore read/parse errors for irrelevant requests
      }
    };

    pageRef.on("response", onResponse);
    timer = setTimeout(() => {
      finish(new Error(`Timed out waiting for ${API_HINT} response`));
    }, timeoutMs);
  });
}

async function ensureBrowser() {
  if (page && !page.isClosed()) return page;
  if (!context) {
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: HEADLESS,
      channel: process.env.BROWSER_CHANNEL || "chrome",
      viewport: { width: 1366, height: 820 },
      locale: "en-IN",
      timezoneId: "Asia/Kolkata",
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      args: [
        "--disable-blink-features=AutomationControlled",
        "--start-maximized",
      ],
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
  }
  browser = context.browser();
  const pages = context.pages();
  page = pages.length ? pages[0] : await context.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  return page;
}

function writeTrace(pnr, trace) {
  try {
    const file = path.join(logDir(), `api_trace_akasaair_${pnr}_${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(trace, null, 2), "utf8");
  } catch (_) {}
}

async function fillReactInput(locator, value) {
  await locator.evaluate((el, val) => {
    el.focus();
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    ).set;
    nativeInputValueSetter.call(el, val);
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur",   { bubbles: true }));
  }, value);
  await sleep(150);
}

function extractData(payload, pnr, contactDetail) {
  const data = payload?.data || {};
  const journeys = Array.isArray(data.journeys) ? data.journeys : [];
  const firstJourney = journeys[0] || {};
  const firstSegment = firstJourney?.segments?.[0] || {};
  const designator = firstJourney?.designator || firstSegment?.designator || {};
  const identifier = firstSegment?.identifier || {};
  const dep = splitIsoDateTime(designator?.departure || "");
  const arr = splitIsoDateTime(designator?.arrival || "");
  const bookingStatusRaw = data?.info?.status;
  const bookingStatus = bookingStatusRaw || "";

  const flightNumber = [identifier?.carrierCode, identifier?.identifier]
    .filter(Boolean)
    .join(" ")
    .trim();

  // Create a map of passengerKey -> passengerSegment info
  const paxSegmentMap = {};
  if (Array.isArray(firstSegment?.passengerSegment)) {
    for (const ps of firstSegment.passengerSegment) {
      if (ps.passengerKey) {
        paxSegmentMap[ps.passengerKey] = ps;
      }
    }
  }

  const passengers = Array.isArray(data?.passengers) ? data.passengers : [];
  const passengerLiftStatuses = passengers
    .map((p, idx) => {
      const key = p?.passengerKey;
      const liftRaw = key ? paxSegmentMap?.[key]?.liftStatus : "";
      return `P${idx + 1}:${liftRaw || "NA"}`;
    })
    .join(" | ");

  const domPassengerSeats = passengers
    .map((p, idx) => {
      const key = p?.passengerKey;
      const paxSeg = paxSegmentMap[key] || {};
      const seat = Array.isArray(paxSeg?.seats) ? paxSeg.seats[0]?.unitDesignator || "NA" : "NA";
      return `P${idx + 1}:${seat}`;
    })
    .join(" | ");

  const passengerNames = passengers
    .map((p) => {
      const n = p?.name || {};
      return [n.first, n.middle, n.last].filter(Boolean).join(" ").trim();
    })
    .filter(Boolean)
    .join(" | ");

  return {
    success: true,
    data: {
      pnr,
      last_name: contactDetail,
      passenger_name: passengerNames,
      flight_number: flightNumber,
      origin: String(designator?.origin || "").trim(),
      destination: String(designator?.destination || "").trim(),
      travel_date: dep.date,
      departure_time: dep.time,
      arrival_time: arr.time,
      booking_status: bookingStatus,
      travel_status: "",
      lift_status: passengerLiftStatuses,
      seat_number: domPassengerSeats,
      fare_amount: String(data?.breakdown?.totalAmount ?? ""),
      raw_json: JSON.stringify({
        airline: "akasaair",
        source: "api",
        booking: data,
      }),
    },
  };
}

async function fetchPNR(pnr, contactDetail) {
  const pageRef = await ensureBrowser();
  const trace = {
    pnr,
    contactDetail,
    startedAt: new Date().toISOString(),
    pageUrlStart: pageRef.url(),
    response: null,
  };

  try {
    // Ensure at least 2 second delay between PNRs
    await sleep(2000 + rand(0, 1500));

    await pageRef.goto(MANAGE_BOOKING_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await pageRef.waitForTimeout(1800);

    const pnrInput = pageRef.locator("#pnr-input").first();
    const nameInput = pageRef.locator("#name-input").first();

    await pnrInput.waitFor({ state: "visible", timeout: 20000 });
    await nameInput.waitFor({ state: "visible", timeout: 20000 });

    await fillReactInput(pnrInput, String(pnr || "").trim().toUpperCase());
    await fillReactInput(nameInput, String(contactDetail || "").trim().toUpperCase());

    const waitResp = waitForAkasaApiPayload(pageRef, 25000);

    const submitBtn = pageRef.locator('button[type="submit"]').first();
    await submitBtn.waitFor({ state: "visible", timeout: 15000 });

    await pageRef.waitForFunction(() => {
      const btn = document.querySelector('button[type="submit"]');
      return !!btn && !btn.disabled;
    }, { timeout: 15000 });

    await sleep(rand(500, 1200));
    await submitBtn.click({ force: true }).catch(() => {
      return pageRef.evaluate(() => {
        const btn = document.querySelector('button[type="submit"]');
        if (btn) btn.click();
      });
    });

    const apiResult = await waitResp;
    trace.responseStatus = apiResult.status;
    trace.responseUrl = apiResult.url;
    if (apiResult.status >= 500) {
      throw new Error(`API failed with status ${apiResult.status}`);
    }

    const json = apiResult.payload;
    if (!json) {
      throw new Error("API response received but JSON body could not be parsed");
    }

    trace.response = json;
    trace.responseBodySnippet = String(apiResult.bodyText || "").slice(0, 3000);
    writeTrace(pnr, trace);

    return extractData(json, pnr, contactDetail);
  } catch (err) {
    const inlineError = await readInlinePageError(pageRef);
    writeTrace(pnr, {
      ...trace,
      inlineError,
      error: err.message,
      doneAt: new Date().toISOString(),
    });
    return { success: false, error: err.message || "Unknown scraping error" };
  }
}

async function closeBrowser() {
  try {
    if (page && !page.isClosed()) await page.close();
  } catch (_) {
  } finally {
    page = null;
  }
  try {
    if (context) await context.close();
  } catch (_) {
  } finally {
    context = null;
  }
  try {
    if (browser) await browser.close();
  } catch (_) {
  } finally {
    browser = null;
  }
}

module.exports = { fetchPNR, closeBrowser };
