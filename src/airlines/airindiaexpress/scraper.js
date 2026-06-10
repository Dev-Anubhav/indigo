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

async function scrapeVisibleGuestStatuses(pageRef) {
  try {
    await pageRef.waitForSelector(".guest-details .guest-details-item", {
      state: "visible",
      timeout: 20000,
    });
  } catch (_) {
    return [];
  }

  return pageRef.evaluate(() => {
    const clean = (value) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();

    return Array.from(
      document.querySelectorAll(".guest-details .guest-details-item")
    ).map((item, index) => {
      const name = clean(item.querySelector(".guest-name .name")?.textContent);
      const checkedBlock = item.querySelector(".checked-block");
      const statusStrong = clean(checkedBlock?.querySelector("strong")?.textContent);
      const statusText = clean(checkedBlock?.textContent);

      return {
        index: index + 1,
        name,
        onward_status: statusStrong,
        status_text: statusText,
      };
    });
  });
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

async function waitForAixApiPayload(pageRef, timeoutMs = 25000) {
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
      if (!resp.url().includes(API_HINT) || resp.request().method() !== "POST") {
        return;
      }

      try {
        const status = resp.status();
        const bodyText = await resp.text();
        const payload = normalizeResponsePayload(bodyText);
        finish(null, {
          status,
          url: resp.url(),
          bodyText,
          payload,
        });
      } catch (err) {
        finish(err);
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
    const file = path.join(logDir(), `api_trace_aix_${pnr}_${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(trace, null, 2), "utf8");
  } catch (_) {}
}

function extractData(payload, pnr, contactDetail, visibleGuests = []) {
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
      const lift =
        visibleGuests[idx]?.onward_status ||
        visibleGuests[idx]?.status_text ||
        mapLiftStatus(liftRaw);
      return `P${idx + 1}:${lift || "NA"}`;
    })
    .join(" | ");

  const passengerName = (
    visibleGuests.length
      ? visibleGuests.map((g) => g.name).filter(Boolean)
      : passengers
          .map((p) => {
            const n = p?.name || {};
            return [n.first, n.middle, n.last].filter(Boolean).join(" ").trim();
          })
          .filter(Boolean)
  ).join(" | ");

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
      travel_status: "",
      lift_status: passengerLiftStatuses,
      seat_number: "",
      fare_amount: String(data?.breakdown?.totalAmount ?? ""),
      raw_json: JSON.stringify({
        apiStatus: {
          bookingStatus,
          bookingStatusRaw,
          passengerLiftStatuses,
        },
        visibleGuests,
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

    const waitResp = waitForAixApiPayload(pageRef, 25000);

    const btn = pageRef.locator('button.fetch-submit-btn:has-text("Get Itinerary")').first();
    await btn.waitFor({ state: "visible", timeout: 15000 });
    await pageRef.waitForFunction(() => {
      const b = document.querySelector("button.fetch-submit-btn");
      return !!b && !b.disabled;
    }, { timeout: 15000 });
    await sleep(rand(600, 1400));
    await btn.click();

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

    const visibleGuests = await scrapeVisibleGuestStatuses(pageRef);
    trace.response = json;
    trace.responseBodySnippet = String(apiResult.bodyText || "").slice(0, 3000);
    trace.visibleGuests = visibleGuests;
    writeTrace(pnr, trace);

    return extractData(json, pnr, contactDetail, visibleGuests);
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
