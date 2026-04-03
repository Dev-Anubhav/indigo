"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const MANAGE_BOOKING_URL =
  "https://www.goindigo.in/account/my-bookings.html?linkNav=Find%20%26%20view%20booking%7CMy%20trips%7CTrips";
const ITINERARY_API_HINT =
  "api-prod-itinerary-skyplus6e.goindigo.in/v2/Itinerary";

const HEADLESS =
  String(process.env.HEADLESS || "false").toLowerCase() !== "false";
const ACTION_MIN_DELAY = parseInt(process.env.ACTION_MIN_DELAY_MS || "250", 10);
const ACTION_MAX_DELAY = parseInt(process.env.ACTION_MAX_DELAY_MS || "900", 10);
const TYPE_MIN_DELAY = parseInt(process.env.TYPE_MIN_DELAY_MS || "35", 10);
const TYPE_MAX_DELAY = parseInt(process.env.TYPE_MAX_DELAY_MS || "120", 10);

const PNR_SELECTORS = [
  'input[name="pnr-booking-ref"]',
  'input[placeholder="PNR / Booking Reference"]',
  'input[placeholder="PNR/Booking Reference"]',
  'input[placeholder*="PNR"]',
  'input[placeholder*="Booking"]',
  'input[customclass="itinerary-retrieve-slider--field"][maxlength="6"]',
  'input[maxlength="6"]',
];

const NAME_SELECTORS = [
  'input[name="email-last-name"]',
  'input[placeholder="Email ID / Last Name"]',
  'input[placeholder="Email/Last Name"]',
  'input[placeholder*="Last Name"]',
  'input[placeholder*="Email"]',
  'input[customclass="itinerary-retrieve-slider--field"]:nth-of-type(2)',
];

let browser = null;
let context = null;
let page = null;

let currentEntryMode = "main_page";
let modeRunsRemaining = 0;

function rand(min, max) {
  return (
    Math.floor(Math.random() * (Math.max(min, max) - Math.min(min, max) + 1)) +
    Math.min(min, max)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanPause(min = ACTION_MIN_DELAY, max = ACTION_MAX_DELAY) {
  await sleep(rand(min, max));
}

async function waitForPageStable(pageRef, timeoutMs = 18000) {
  try {
    await pageRef.waitForLoadState("domcontentloaded", {
      timeout: Math.min(timeoutMs, 12000),
    });
  } catch (_) {
    // continue
  }

  try {
    await pageRef.waitForLoadState("networkidle", { timeout: timeoutMs });
  } catch (_) {
    await sleep(900);
  }
}

function logDir() {
  const dir = path.resolve(
    process.env.LOG_PATH ? path.dirname(process.env.LOG_PATH) : "./logs"
  );
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

function truncate(text, max = 50000) {
  const s = safeText(text);
  return s.length > max ? `${s.slice(0, max)}...[truncated]` : s;
}

function writeTrace(pnr, trace) {
  try {
    const stamp = Date.now();
    const file = path.join(logDir(), `api_trace_${pnr}_${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(trace, null, 2), "utf8");
  } catch (_) {
    // non-blocking
  }
}

function pickEntryMode(canUseSidePanel) {
  if (!canUseSidePanel) {
    currentEntryMode = "main_page";
    modeRunsRemaining = 0;
    return currentEntryMode;
  }

  if (modeRunsRemaining > 0) {
    modeRunsRemaining -= 1;
    return currentEntryMode;
  }

  currentEntryMode = Math.random() < 0.62 ? "side_panel" : "main_page";
  modeRunsRemaining = Math.random() < 0.55 ? 1 : 0;
  return currentEntryMode;
}

function oppositeMode(mode) {
  return mode === "side_panel" ? "main_page" : "side_panel";
}

async function isBlockedOrFailoverPage(pageRef, trace) {
  const url = String(pageRef.url() || "").toLowerCase();
  if (url.includes("akamfailoverpage")) return true;

  const hadFailoverResponse = (trace.responses || []).some((r) =>
    String(r.url || "")
      .toLowerCase()
      .includes("/akamfailoverpage/")
  );
  if (hadFailoverResponse) return true;

  const text = await pageRef
    .evaluate(() => (document.body ? document.body.innerText : ""))
    .catch(() => "");
  const low = String(text).toLowerCase();
  if (low.includes("something went wrong") && low.includes("customer support"))
    return true;
  if (low.includes("access denied") || low.includes("forbidden")) return true;
  return false;
}

async function ensureBrowser() {
  if (page && !page.isClosed()) return page;

  if (!browser) {
    browser = await chromium.launch({
      headless: HEADLESS,
      args: ["--disable-blink-features=AutomationControlled"],
    });
  }

  context = await browser.newContext({
    viewport: { width: 1366, height: 820 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  });

  page = await context.newPage();
  page.setDefaultTimeout(35000);
  page.setDefaultNavigationTimeout(45000);

  return page;
}

async function isItineraryContext(pageRef) {
  const url = String(pageRef.url() || "").toLowerCase();
  if (url.includes("/book/itinerary")) return true;
  const hasRetrieveAnother = await pageRef
    .locator(
      'button:has-text("Retrieve another booking"), a:has-text("RETRIEVE ANOTHER BOOKING")'
    )
    .count()
    .catch(() => 0);
  return hasRetrieveAnother > 0;
}

function deepFindFirst(obj, predicates, seen = new Set()) {
  if (!obj || typeof obj !== "object") return null;
  if (seen.has(obj)) return null;
  seen.add(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFindFirst(item, predicates, seen);
      if (found != null) return found;
    }
    return null;
  }

  for (const [k, v] of Object.entries(obj)) {
    const key = k.toLowerCase();
    if (predicates.some((fn) => fn(key, v))) return v;
  }

  for (const v of Object.values(obj)) {
    const found = deepFindFirst(v, predicates, seen);
    if (found != null) return found;
  }

  return null;
}

function deepFindNode(obj, predicate, seen = new Set()) {
  if (!obj || typeof obj !== "object") return null;
  if (seen.has(obj)) return null;
  seen.add(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = deepFindNode(item, predicate, seen);
      if (found) return found;
    }
    return null;
  }

  if (predicate(obj)) return obj;

  for (const v of Object.values(obj)) {
    const found = deepFindNode(v, predicate, seen);
    if (found) return found;
  }

  return null;
}

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toUpperCase();
}

function extractFromItinerary(payload, pnr, lastName) {
  const bookingStatus =
    deepFindFirst(payload, [
      (key) => key === "bookingstatus",
      (key) => key === "status" || key.endsWith("bookingstatus"),
    ]) || "";

  const liftStatus =
    deepFindFirst(payload, [
      (key) => key === "liftstatus",
      (key) => key.endsWith("liftstatus"),
      (key) => key === "upliftstatus",
    ]) || "";

  const segment =
    deepFindNode(payload, (node) => {
      const keys = Object.keys(node).map((k) => k.toLowerCase());
      return (
        keys.includes("flightnumber") ||
        keys.includes("flightno") ||
        keys.includes("origin") ||
        keys.includes("destination")
      );
    }) || {};

  const passenger =
    deepFindNode(payload, (node) => {
      const keys = Object.keys(node).map((k) => k.toLowerCase());
      return (
        keys.includes("firstname") ||
        keys.includes("lastname") ||
        keys.includes("passengername")
      );
    }) || {};

  const flightNo =
    segment.flightNumber ||
    segment.flightNo ||
    segment.flightno ||
    deepFindFirst(payload, [
      (key) => key === "flightnumber" || key === "flightno",
    ]) ||
    "";

  const origin =
    segment.origin ||
    segment.from ||
    segment.departureAirport ||
    deepFindFirst(payload, [(key) => key === "origin" || key === "from"]) ||
    "";

  const destination =
    segment.destination ||
    segment.to ||
    segment.arrivalAirport ||
    deepFindFirst(payload, [(key) => key === "destination" || key === "to"]) ||
    "";

  const travelDate =
    segment.travelDate ||
    segment.departureDate ||
    deepFindFirst(payload, [
      (key) => key === "traveldate" || key === "departuredate",
    ]) ||
    "";

  const departureTime =
    segment.departureTime ||
    deepFindFirst(payload, [
      (key) => key === "departuretime" || key === "std",
    ]) ||
    "";

  const arrivalTime =
    segment.arrivalTime ||
    deepFindFirst(payload, [(key) => key === "arrivaltime" || key === "sta"]) ||
    "";

  const seatNumber =
    deepFindFirst(payload, [
      (key) => key === "seatnumber" || key === "seatno" || key === "seat",
    ]) || "";

  const fareAmount =
    deepFindFirst(payload, [
      (key) =>
        key === "fareamount" || key === "amountpaid" || key === "totalfare",
    ]) || "";

  const firstName = passenger.firstName || passenger.firstname || "";
  const surname = passenger.lastName || passenger.lastname || "";
  const passengerName =
    passenger.passengerName || `${firstName} ${surname}`.trim() || "";

  return {
    success: true,
    data: {
      pnr,
      last_name: lastName,
      passenger_name: passengerName,
      flight_number: safeText(flightNo),
      origin: safeText(origin),
      destination: safeText(destination),
      travel_date: safeText(travelDate),
      departure_time: safeText(departureTime),
      arrival_time: safeText(arrivalTime),
      booking_status: normalizeStatus(bookingStatus),
      lift_status: normalizeStatus(liftStatus),
      seat_number: safeText(seatNumber),
      fare_amount: safeText(fareAmount),
      raw_json: JSON.stringify({
        apiStatus: { bookingStatus, liftStatus },
        itinerary: payload,
      }),
    },
  };
}

async function tryFill(pageRef, selectors, value) {
  for (const selector of selectors) {
    try {
      const locator = pageRef.locator(selector).first();
      if (await locator.count()) {
        await locator.click({ timeout: 2000 });
        await humanPause(80, 220);
        await locator.fill("");
        await locator.type(value, {
          delay: rand(TYPE_MIN_DELAY, TYPE_MAX_DELAY),
        });
        return true;
      }
    } catch (_) {
      // try next selector
    }
  }
  return false;
}

async function waitForInteractiveInput(pageRef, selectors, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    for (const selector of selectors) {
      try {
        const locator = pageRef.locator(selector).first();
        if (await locator.count()) {
          const isVisible = await locator.isVisible().catch(() => false);
          const isEnabled = await locator.isEnabled().catch(() => false);
          if (isVisible && isEnabled) return true;
        }
      } catch (_) {
        // keep trying
      }
    }
    await sleep(250);
  }
  return false;
}

async function fillByHeuristic(pageRef, kind, value) {
  return pageRef.evaluate(
    ({ kind, value }) => {
      const normalize = (text) => String(text || "").toLowerCase();
      const visible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (!style) return false;
        if (style.display === "none" || style.visibility === "hidden")
          return false;
        return el.getClientRects().length > 0;
      };

      const inputs = Array.from(document.querySelectorAll("input"));
      const scored = inputs
        .filter((el) => !el.disabled && !el.readOnly && visible(el))
        .map((el) => {
          const name = normalize(el.getAttribute("name"));
          const placeholder = normalize(el.getAttribute("placeholder"));
          const aria = normalize(el.getAttribute("aria-label"));
          const cls = normalize(el.getAttribute("class"));
          const text = `${name} ${placeholder} ${aria} ${cls}`;

          let score = 0;
          if (kind === "pnr") {
            if (text.includes("pnr")) score += 5;
            if (text.includes("booking")) score += 3;
            if (text.includes("reference")) score += 3;
            if (el.maxLength === 6) score += 1;
          } else {
            if (text.includes("last")) score += 4;
            if (text.includes("surname")) score += 4;
            if (text.includes("email")) score += 3;
            if (text.includes("name")) score += 2;
          }

          return { el, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);

      if (!scored.length) return false;

      const target = scored[0].el;
      target.focus();
      target.value = "";
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.value = String(value || "");
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      target.blur();
      return true;
    },
    { kind, value }
  );
}

async function clickFirst(pageRef, selectors) {
  for (const selector of selectors) {
    try {
      const locator = pageRef.locator(selector).first();
      if (await locator.count()) {
        await locator.click({ timeout: 5000 });
        return true;
      }
    } catch (_) {
      // try next selector
    }
  }
  return false;
}

async function openRetrievePanelIfNeeded(pageRef) {
  const inItinerary = await isItineraryContext(pageRef);
  if (!inItinerary) return;

  await sleep(5000);
  await clickFirst(pageRef, [
    'button:has-text("Retrieve another booking")',
    'a:has-text("RETRIEVE ANOTHER BOOKING")',
    ".retrieve-another-itinerary button",
  ]);
  await waitForPageStable(pageRef, 9000);
  await humanPause(400, 900);
}

async function waitForFormReady(pageRef, timeoutMs = 18000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hasInputs = await pageRef.locator("input").count();
    if (hasInputs > 0) {
      const looksReady = await pageRef
        .evaluate(() => {
          const txt = document.body
            ? document.body.innerText.toLowerCase()
            : "";
          return (
            txt.includes("pnr") ||
            txt.includes("booking reference") ||
            txt.includes("find your booking")
          );
        })
        .catch(() => false);
      if (looksReady) return true;
    }
    await sleep(300);
  }
  return false;
}

async function submitLookup(pageRef) {
  await humanPause(250, 650);
  const clicked = await clickFirst(pageRef, [
    'button:has-text("Get Started")',
    'button[title="Get Started"]',
    '.retrieve-pnr-cta button:has-text("Retrieve Itinerary")',
    'button:has-text("Retrieve Itinerary")',
    'button[type="submit"]',
  ]);

  if (!clicked) {
    throw new Error(
      "Submit button not found (Get Started / Retrieve Itinerary)."
    );
  }
}

async function prepareMode(pageRef, mode, trace, pnr) {
  if (mode === "main_page") {
    await pageRef.goto(MANAGE_BOOKING_URL, { waitUntil: "domcontentloaded" });
    await waitForPageStable(pageRef, 15000);
    await humanPause(500, 1100);

    const blockedAtLanding = await isBlockedOrFailoverPage(pageRef, trace);
    if (blockedAtLanding) {
      const snapPath = path.join(
        logDir(),
        `error_failover_${pnr}_${Date.now()}.png`
      );
      await pageRef
        .screenshot({ path: snapPath, fullPage: true })
        .catch(() => {});
      throw new Error("Akamai failover page detected");
    }

    await waitForFormReady(pageRef, 12000);
    return true;
  }

  const inItinerary = await isItineraryContext(pageRef);
  if (!inItinerary) return false;

  await openRetrievePanelIfNeeded(pageRef);
  await waitForFormReady(pageRef, 9000);
  return true;
}

async function fillLookupInputs(pageRef, pnr, lastName) {
  await waitForInteractiveInput(pageRef, PNR_SELECTORS, 10000);
  await waitForInteractiveInput(pageRef, NAME_SELECTORS, 10000);

  let pnrFilled = await tryFill(
    pageRef,
    PNR_SELECTORS,
    String(pnr).trim().toUpperCase()
  );
  let nameFilled = await tryFill(
    pageRef,
    NAME_SELECTORS,
    String(lastName).trim().toUpperCase()
  );

  if (!pnrFilled || !nameFilled) {
    const pnrFallback = await fillByHeuristic(
      pageRef,
      "pnr",
      String(pnr).trim().toUpperCase()
    );
    const nameFallback = await fillByHeuristic(
      pageRef,
      "lastname",
      String(lastName).trim().toUpperCase()
    );
    pnrFilled = pnrFilled || pnrFallback;
    nameFilled = nameFilled || nameFallback;
  }

  return pnrFilled && nameFilled;
}

async function fetchPNR(pnr, lastName, attempt = 1) {
  const pageRef = await ensureBrowser();
  const trace = {
    pnr,
    lastName,
    startedAt: new Date().toISOString(),
    pageUrlStart: pageRef.url(),
    requests: [],
    responses: [],
    itineraryResponse: null,
    cookiesAtCapture: [],
    attempt,
    entryMode: "",
    fallbackMode: "",
  };

  const onRequest = (request) => {
    const url = request.url();
    if (!url.includes("goindigo.in") && !url.includes("skyplus6e")) return;

    trace.requests.push({
      time: new Date().toISOString(),
      method: request.method(),
      url,
      resourceType: request.resourceType(),
      headers: request.headers(),
      postData: truncate(request.postData() || ""),
    });
  };

  const onResponse = async (response) => {
    const url = response.url();
    if (!url.includes("goindigo.in") && !url.includes("skyplus6e")) return;

    let body = "";
    const ct = (response.headers()["content-type"] || "").toLowerCase();
    if (ct.includes("json") || url.includes("/v2/")) {
      try {
        body = truncate(await response.text(), 50000);
      } catch (_) {
        body = "";
      }
    }

    trace.responses.push({
      time: new Date().toISOString(),
      status: response.status(),
      url,
      headers: response.headers(),
      body,
    });

    if (url.includes(ITINERARY_API_HINT) && body) {
      try {
        trace.itineraryResponse = JSON.parse(body);
      } catch (_) {
        // ignore
      }
    }
  };

  pageRef.on("request", onRequest);
  pageRef.on("response", onResponse);

  try {
    const canUseSidePanel = await isItineraryContext(pageRef);
    const selectedMode = pickEntryMode(canUseSidePanel);
    trace.entryMode = selectedMode;

    let activeMode = selectedMode;
    let prepared = await prepareMode(pageRef, selectedMode, trace, pnr);

    if (!prepared && selectedMode !== "main_page") {
      activeMode = "main_page";
      prepared = await prepareMode(pageRef, activeMode, trace, pnr);
    }

    if (!prepared) {
      throw new Error("Could not prepare booking page in selected mode.");
    }

    let inputsFilled = await fillLookupInputs(pageRef, pnr, lastName);

    if (!inputsFilled) {
      const fallbackMode = oppositeMode(activeMode);
      trace.fallbackMode = fallbackMode;

      const fallbackPrepared = await prepareMode(
        pageRef,
        fallbackMode,
        trace,
        pnr
      );
      if (fallbackPrepared) {
        inputsFilled = await fillLookupInputs(pageRef, pnr, lastName);
      }
    }

    if (!inputsFilled) {
      const snapPath = path.join(
        logDir(),
        `error_fields_${pnr}_${Date.now()}.png`
      );
      await pageRef
        .screenshot({ path: snapPath, fullPage: true })
        .catch(() => {});
      throw new Error(
        "Could not find input fields for PNR/Last Name in both modes."
      );
    }

    await humanPause(350, 900);

    const waitItinerary = pageRef
      .waitForResponse(
        (resp) =>
          resp.url().includes(ITINERARY_API_HINT) && resp.status() < 500,
        { timeout: 25000 }
      )
      .catch(() => null);

    await submitLookup(pageRef);
    await waitForPageStable(pageRef, 12000);

    const itResp = await waitItinerary;
    if (itResp) {
      try {
        trace.itineraryResponse = await itResp.json();
      } catch (_) {
        // ignore
      }
    }

    await humanPause(800, 1400);
    trace.cookiesAtCapture = await context.cookies();

    if (!trace.itineraryResponse) {
      throw new Error("Itinerary API response not captured.");
    }

    const extracted = extractFromItinerary(
      trace.itineraryResponse,
      pnr,
      lastName
    );
    writeTrace(pnr, {
      ...trace,
      doneAt: new Date().toISOString(),
      extracted: extracted.data,
    });

    return extracted;
  } catch (err) {
    if (
      String(err.message || "").includes("Akamai failover page detected") &&
      attempt < 2
    ) {
      await closeBrowser();
      await sleep(rand(3500, 8000));
      return fetchPNR(pnr, lastName, attempt + 1);
    }

    writeTrace(pnr, {
      ...trace,
      doneAt: new Date().toISOString(),
      error: err.message,
    });

    return {
      success: false,
      error: err.message || "Unknown scraping error",
    };
  } finally {
    pageRef.off("request", onRequest);
    pageRef.off("response", onResponse);
  }
}

async function closeBrowser() {
  try {
    if (page && !page.isClosed()) {
      await page.close();
    }
  } catch (_) {
    // ignore
  } finally {
    page = null;
  }

  try {
    if (context) await context.close();
  } catch (_) {
    // ignore
  } finally {
    context = null;
  }

  try {
    if (browser) await browser.close();
  } catch (_) {
    // ignore
  } finally {
    browser = null;
  }
}

module.exports = {
  fetchPNR,
  closeBrowser,
};
