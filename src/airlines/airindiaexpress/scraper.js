"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const MANAGE_BOOKING_URL = "https://www.airindiaexpress.com/manage-booking";
const API_HINT = "/b2c-CheckIn/v2/retrieve/mmb/byRecordLocator";
const HEADLESS =
  String(process.env.HEADLESS || "false").toLowerCase() !== "false";

let browser = null;
let context = null;
let page = null;
const USER_DATA_DIR = path.resolve(
  process.env.AIX_USER_DATA_DIR || "./data/chrome-airindiaexpress-profile"
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

function mapBookingStatus(code) {
  const c = Number(code);
  const map = {
    0: "HOLD",
    1: "PENDING",
    2: "CONFIRMED",
    3: "CANCELLED",
    4: "COMPLETED",
  };
  if (Number.isNaN(c)) return String(code || "").trim();
  return map[c] ? `${map[c]} (${c})` : `STATUS_${c}`;
}

function mapLiftStatus(code) {
  const c = Number(code);
  const map = {
    0: "NOT_CHECKED_IN",
    1: "CHECKED_IN",
    2: "BOARDED",
    3: "NO_SHOW",
    4: "OFFLOADED",
  };
  if (Number.isNaN(c)) return String(code || "").trim();
  return map[c] ? `${map[c]} (${c})` : `LIFT_${c}`;
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
    const file = path.join(logDir(), `api_trace_aix_${pnr}_${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(trace, null, 2), "utf8");
  } catch (_) {}
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
  const bookingStatus = mapBookingStatus(bookingStatusRaw);

  const flightNumber = [identifier?.carrierCode, identifier?.identifier]
    .filter(Boolean)
    .join(" ")
    .trim();

  const paxSegmentMap =
    firstSegment?.passengerSegment && typeof firstSegment.passengerSegment === "object"
      ? firstSegment.passengerSegment
      : {};
  const passengers = Array.isArray(data?.passengers) ? data.passengers : [];
  const passengerLiftStatuses = passengers
    .map((p, idx) => {
      const key = p?.passengerKey;
      const liftRaw = key ? paxSegmentMap?.[key]?.liftStatus : "";
      const lift = mapLiftStatus(liftRaw);
      return `P${idx + 1}:${lift || "NA"}`;
    })
    .join(" | ");

  const passengerName = passengers
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
      passenger_name: passengerName,
      flight_number: flightNumber,
      origin: String(designator?.origin || "").trim(),
      destination: String(designator?.destination || "").trim(),
      travel_date: dep.date,
      departure_time: dep.time,
      arrival_time: arr.time,
      booking_status: bookingStatus,
      lift_status: passengerLiftStatuses,
      seat_number: "",
      fare_amount: String(data?.breakdown?.totalAmount ?? ""),
      raw_json: JSON.stringify({
        apiStatus: {
          bookingStatus,
          bookingStatusRaw,
          passengerLiftStatuses,
        },
        itinerary: payload,
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
    await sleep(rand(2000, 5000));

    const alreadyOnTarget = String(pageRef.url() || "").includes(
      "airindiaexpress.com/manage-booking"
    );

    if (!alreadyOnTarget) {
      await pageRef.goto(MANAGE_BOOKING_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    } else {
      await pageRef.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    }
    await pageRef.waitForTimeout(1800);

    await pageRef.waitForSelector("#addtnlDetail", { state: "visible", timeout: 20000 });
    await pageRef.waitForSelector("#recordLocator", { state: "visible", timeout: 20000 });

    await pageRef.locator("#addtnlDetail").first().click();
    await pageRef.locator("#addtnlDetail").first().fill(String(contactDetail || "").trim());
    await pageRef.locator("#recordLocator").first().click();
    await pageRef.locator("#recordLocator").first().fill(String(pnr || "").trim().toUpperCase());

    const waitResp = pageRef.waitForResponse(
      (resp) => resp.url().includes(API_HINT) && resp.request().method() === "POST",
      { timeout: 20000 }
    );

    const btn = pageRef.locator('button.fetch-submit-btn:has-text("Get Itinerary")').first();
    await btn.waitFor({ state: "visible", timeout: 15000 });
    await pageRef.waitForFunction(() => {
      const b = document.querySelector("button.fetch-submit-btn");
      return !!b && !b.disabled;
    }, { timeout: 15000 });
    await sleep(rand(600, 1400));
    await btn.click();

    const resp = await waitResp;
    trace.responseStatus = resp.status();
    trace.responseUrl = resp.url();
    if (resp.status() >= 500) throw new Error(`API failed with status ${resp.status()}`);

    const json = await resp.json();
    trace.response = json;
    writeTrace(pnr, trace);

    return extractData(json, pnr, contactDetail);
  } catch (err) {
    writeTrace(pnr, { ...trace, error: err.message, doneAt: new Date().toISOString() });
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
