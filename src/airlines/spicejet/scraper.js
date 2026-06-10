"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const MANAGE_BOOKING_URL = "https://www.spicejet.com/#manage-booking";
const API_HINT = "/api/v1/booking/retrieveBookingByPNR";
const HEADLESS =
  String(process.env.HEADLESS || "false").toLowerCase() !== "false";

let browser = null;
let context = null;
let page = null;
const USER_DATA_DIR = path.resolve(
  process.env.SPICEJET_USER_DATA_DIR || "./data/chrome-spicejet-profile"
);

function logDir() {
  const dir = path.resolve(
    process.env.LOG_PATH ? path.dirname(process.env.LOG_PATH) : "./logs"
  );
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  return map[c] || `STATUS_${c}`;
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
  return map[c] || `LIFT_${c}`;
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
  page.setDefaultNavigationTimeout(45000);
  return page;
}

function writeTrace(pnr, trace) {
  try {
    const file = path.join(
      logDir(),
      `api_trace_spicejet_${pnr}_${Date.now()}.json`
    );
    fs.writeFileSync(file, JSON.stringify(trace, null, 2), "utf8");
  } catch (_) {}
}

async function waitForSpicejetApiPayload(pageRef, timeoutMs = 25000) {
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
      if (
        !resp.url().includes(API_HINT) ||
        resp.request().method() !== "GET"
      ) {
        return;
      }
      try {
        const bodyText = await resp.text();
        finish(null, {
          status: resp.status(),
          url: resp.url(),
          bodyText,
          payload: normalizeResponsePayload(bodyText),
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

async function fetchSpicejetBookingDirect(pageRef, pnr, detail) {
  const url = `/api/v1/booking/retrieveBookingByPNR?recordLocator=${encodeURIComponent(
    String(pnr || "").trim().toUpperCase()
  )}&lastName=${encodeURIComponent(
    String(detail || "").trim().toUpperCase()
  )}`;

  return pageRef.evaluate(async (targetUrl) => {
    const resp = await fetch(targetUrl, {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json, text/plain, */*" },
    });
    return {
      status: resp.status,
      url: targetUrl,
      bodyText: await resp.text(),
    };
  }, url);
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM SCRAPE FALLBACK
// Used when API returns 500 or no JSON.
// Reads the booking result page directly from rendered HTML.
// ─────────────────────────────────────────────────────────────────────────────

async function expandAccordion(pageRef, label) {
  try {
    const expanded = await pageRef.evaluate((sectionLabel) => {
      const triggers = Array.from(document.querySelectorAll('div[tabindex="0"]'));
      const trigger = triggers.find(
        (el) => el.textContent.trim().startsWith(sectionLabel)
      );
      if (!trigger) return false;
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      return true;
    }, label);
    if (expanded) await sleep(800);
    return expanded;
  } catch (_) {
    return false;
  }
}

async function scrapeBookingPageDOM(pageRef) {
  try {
    await pageRef.waitForSelector('[data-testid="test-id-tripFlightGeneralInfo"]', {
      timeout: 15000,
    });
  } catch (_) {}

  await sleep(500);

  await expandAccordion(pageRef, "Travel Information");
  await expandAccordion(pageRef, "Passenger Information");
  await expandAccordion(pageRef, "Transaction Summary");

  return pageRef.evaluate(() => {
    const clean = (el) =>
      el ? String(el.textContent || "").replace(/\s+/g, " ").trim() : "";

    const findLabelValue = (labelText) => {
      const allDivs = Array.from(document.querySelectorAll("div.css-1dbjc4n"));
      for (const div of allDivs) {
        const children = Array.from(div.children);
        if (children.length === 2) {
          const valEl = children[0];
          const lblEl = children[1];
          const lbl = clean(lblEl);
          if (lbl === labelText) return clean(valEl);
        }
      }
      return "";
    };

    const pnr           = findLabelValue("PNR/Booking No");
    const ticketNumber  = findLabelValue("Ticket Number");
    const bookingStatus = findLabelValue("Status");
    const bookingDate   = findLabelValue("Booking Date");
    const paymentStatus = findLabelValue("Payment status");

    let origin = "", destination = "", flightNumber = "", travelDate = "";
    const generalInfo = document.querySelector('[data-testid="test-id-tripFlightGeneralInfo"]');
    if (generalInfo) {
      const routeTexts = Array.from(
        generalInfo.querySelectorAll(".r-qsz3a2.r-a023e6")
      ).map((el) => clean(el));
      if (routeTexts.length >= 2) {
        origin      = routeTexts[0];
        destination = routeTexts[1];
      }
      const metaTexts = Array.from(
        generalInfo.querySelectorAll(".r-djgu52")
      ).map((el) => clean(el));
      if (metaTexts.length >= 1) flightNumber = metaTexts[0];
      if (metaTexts.length >= 3) travelDate   = metaTexts[2];
    }

    let departureTime = "", arrivalTime = "", duration = "",
        terminal = "", flightStatus = "";

    const travelStatusCandidates = [
      "Departed", "Completed", "Cancelled", "Delayed", "On Time", "Scheduled",
    ];
    const allTextNodes = Array.from(document.querySelectorAll("div[dir='auto']")).map(clean);

    flightStatus = allTextNodes.find((t) => travelStatusCandidates.includes(t)) || "";

    const timePattern = /^\d{2}:\d{2}$/;
    const times = allTextNodes.filter((t) => timePattern.test(t));
    if (times.length >= 1) departureTime = times[0];
    if (times.length >= 2) arrivalTime   = times[1];

    const durationPattern = /^\d+h\s*\d+m$/i;
    duration = allTextNodes.find((t) => durationPattern.test(t)) || "";

    const terminalPattern = /^Terminal\s+\d+$/i;
    terminal = allTextNodes.find((t) => terminalPattern.test(t)) || "";

    const labelValuePairs = {};
    const allLabelValueBlocks = Array.from(
      document.querySelectorAll(".css-1dbjc4n.r-w0va4e")
    );
    for (const block of allLabelValueBlocks) {
      const children = Array.from(block.children);
      if (children.length === 2) {
        const val = clean(children[0]);
        const lbl = clean(children[1]);
        if (lbl && val) labelValuePairs[lbl] = val;
      }
    }

    const namePattern = /^(Mr|Mrs|Ms|Miss|Master|Dr)\.?\s+\w/i;
    const passengerNames = Array.from(document.querySelectorAll("div[dir='auto']"))
      .map(clean)
      .filter((t) => namePattern.test(t));

    const seatPattern = /^\d{1,2}[A-Z]$/;
    const seatNumbers = Array.from(document.querySelectorAll("div[dir='auto']"))
      .map(clean)
      .filter((t) => seatPattern.test(t));

    const passengers = passengerNames.map((name, i) => ({
      name,
      seat: seatNumbers[i] || "",
    }));

    let totalAmount = "", fareBreakdown = [];
    const fareLabels = [
      "Base Fare", "Taxes & Fees", "Seat Charges", "Meal Charges",
      "Baggage Charges", "Convenience Fee", "Insurance",
      "Total Amount", "Amount Paid",
    ];
    for (const lbl of fareLabels) {
      if (labelValuePairs[lbl]) {
        fareBreakdown.push(`${lbl}: ${labelValuePairs[lbl]}`);
        if (lbl === "Total Amount" || lbl === "Amount Paid") {
          totalAmount = labelValuePairs[lbl];
        }
      }
    }

    if (!totalAmount) {
      const amountPattern = /^[₹$]?\s*[\d,]+(\.\d{1,2})?$/;
      const amounts = allTextNodes.filter((t) =>
        amountPattern.test(t.replace(/\s/g, ""))
      );
      if (amounts.length > 0) totalAmount = amounts[amounts.length - 1];
    }

    return {
      pnr,
      ticket_number:   ticketNumber,
      booking_status:  bookingStatus,
      booking_date:    bookingDate,
      payment_status:  paymentStatus,
      origin,
      destination,
      flight_number:   flightNumber,
      travel_date:     travelDate,
      departure_time:  departureTime,
      arrival_time:    arrivalTime,
      duration,
      terminal,
      flight_status:   flightStatus,
      passengers,
      total_amount:    totalAmount,
      fare_breakdown:  fareBreakdown.join(" | "),
      label_value_map: labelValuePairs,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function deriveTravelStatus(booking, domData = {}) {
  if (domData.flight_status) return domData.flight_status;
  if (domData.travel_status) return domData.travel_status;

  const segment = booking?.journeys?.[0]?.segments?.[0] || {};
  const legDetails = segment?.legs?.[0]?.legDetails || {};
  const op = legDetails?.operationDetails || {};
  const tripTimes = op?.tripOperationTimes || {};

  if (String(domData.booking_status || "").toUpperCase() === "CANCELLED") return "Cancelled";
  if (tripTimes?.offBlockTime || tripTimes?.airborneTime) return "Departed";
  if (segment?.isBoardingPassGenerated) return "Checked-in";
  return "";
}

function extractDataFromApi(payload, pnr, detail, domData = {}) {
  const booking = payload?.bookingData || payload || {};
  const firstJourney = Array.isArray(booking?.journeys)
    ? booking.journeys[0] || {} : {};
  const firstSegment = firstJourney?.segments?.[0] || {};
  const designator   = firstJourney?.designator || firstSegment?.designator || {};
  const identifier   = firstSegment?.identifier || {};
  const dep = splitIsoDateTime(designator?.departure || "");
  const arr = splitIsoDateTime(designator?.arrival   || "");

  const bookingStatus =
    domData.booking_status || mapBookingStatus(booking?.info?.status);
  const travelStatus = deriveTravelStatus(booking, domData);

  const passengerMap =
    booking?.passengers && typeof booking.passengers === "object"
      ? booking.passengers : {};
  const segmentPassengerMap =
    firstSegment?.passengerSegment &&
    typeof firstSegment.passengerSegment === "object"
      ? firstSegment.passengerSegment : {};

  const passengerNames = Object.values(passengerMap)
    .map((p) => {
      const name = p?.name || {};
      return [name.title, name.first, name.middle, name.last]
        .filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    })
    .filter(Boolean).join(" | ");

  const passengerLiftStatuses = Object.keys(passengerMap)
    .map((key, idx) => {
      const lift = mapLiftStatus(segmentPassengerMap?.[key]?.liftStatus);
      return `P${idx + 1}:${lift || "NA"}`;
    })
    .join(" | ");

  const domPassengerSeats = (domData.passengers || [])
    .map((p, i) => `P${i + 1}:${p.seat || "NA"}`)
    .join(" | ");

  return {
    success: true,
    source: "api",
    data: {
      pnr,
      last_name:       detail,
      passenger_name:  passengerNames || (domData.passengers || []).map((p) => p.name).join(" | "),
      flight_number:   [identifier?.carrierCode, identifier?.identifier].filter(Boolean).join(" ").trim() || domData.flight_number || "",
      origin:          String(designator?.origin || "").trim() || domData.origin || "",
      destination:     String(designator?.destination || "").trim() || domData.destination || "",
      travel_date:     dep.date || domData.travel_date || "",
      departure_time:  dep.time || domData.departure_time || "",
      arrival_time:    arr.time || domData.arrival_time || "",
      duration:        domData.duration || "",
      terminal:        domData.terminal || "",
      booking_status:  bookingStatus,
      travel_status:   travelStatus,
      lift_status:     passengerLiftStatuses,
      seat_number:     domPassengerSeats,
      fare_amount:     String(booking?.breakdown?.totalAmount ?? "") || domData.total_amount || "",
      ticket_number:   domData.ticket_number || "",
      booking_date:    domData.booking_date || "",
      payment_status:  domData.payment_status || "",
      fare_breakdown:  domData.fare_breakdown || "",
      raw_json: JSON.stringify({ airline: "spicejet", source: "api", domData, booking }),
    },
  };
}

function extractDataFromDOM(domData, pnr, detail) {
  return {
    success: true,
    source: "dom",
    data: {
      pnr:             domData.pnr || pnr,
      last_name:       detail,
      passenger_name:  (domData.passengers || []).map((p) => p.name).join(" | "),
      flight_number:   domData.flight_number || "",
      origin:          domData.origin || "",
      destination:     domData.destination || "",
      travel_date:     domData.travel_date || "",
      departure_time:  domData.departure_time || "",
      arrival_time:    domData.arrival_time || "",
      duration:        domData.duration || "",
      terminal:        domData.terminal || "",
      booking_status:  domData.booking_status || "",
      travel_status:   domData.flight_status || domData.booking_status || "",
      lift_status:     (domData.passengers || []).map((_, i) => `P${i + 1}:NA`).join(" | "),
      seat_number:     (domData.passengers || []).map((p, i) => `P${i + 1}:${p.seat || "NA"}`).join(" | "),
      fare_amount:     domData.total_amount || "",
      ticket_number:   domData.ticket_number || "",
      booking_date:    domData.booking_date || "",
      payment_status:  domData.payment_status || "",
      fare_breakdown:  domData.fare_breakdown || "",
      raw_json: JSON.stringify({ airline: "spicejet", source: "dom", domData }),
    },
  };
}

async function resolveFormInputs(pageRef) {
  const pnrPrimary = pageRef
    .locator('input[maxlength="8"][placeholder*="W3X3H8"]')
    .first();
  const detailPrimary = pageRef
    .locator('input[placeholder*="spicejet.com / Doe"]')
    .first();

  const pnrVisible = await pnrPrimary.isVisible().catch(() => false);
  if (pnrVisible) {
    return { pnrInput: pnrPrimary, detailInput: detailPrimary };
  }

  const container = pageRef.locator(
    '[id*="manage"], [class*="manage"], [class*="booking"], form'
  );
  return {
    pnrInput: container.locator("input").nth(0),
    detailInput: container.locator("input").nth(1),
  };
}

async function fillReactInput(locator, value) {
  await locator.click();
  await locator.evaluate((el, val) => {
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    ).set;
    nativeInputValueSetter.call(el, val);
    el.dispatchEvent(new Event("input",  { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await sleep(150);
}

async function clickSearchBooking(pageRef) {
  await pageRef.evaluate(() => {
    const el = Array.from(document.querySelectorAll('div[tabindex="0"]')).find(
      (d) => d.textContent.trim().startsWith("Search Booking")
    );
    if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
  });

  await sleep(400);

  const clicked = await pageRef.evaluate(() => {
    const el = Array.from(document.querySelectorAll('div[tabindex="0"]')).find(
      (d) => d.textContent.trim().startsWith("Search Booking")
    );
    if (!el) return false;

    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const pOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, pointerType: "mouse" };
    const mOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };

    el.dispatchEvent(new PointerEvent("pointerover",  pOpts));
    el.dispatchEvent(new PointerEvent("pointerenter", pOpts));
    el.dispatchEvent(new PointerEvent("pointerdown",  pOpts));
    el.dispatchEvent(new MouseEvent("mousedown",      mOpts));
    el.dispatchEvent(new PointerEvent("pointerup",    pOpts));
    el.dispatchEvent(new MouseEvent("mouseup",        mOpts));
    el.dispatchEvent(new MouseEvent("click",          mOpts));
    return true;
  });

  if (!clicked) {
    const elLocator = pageRef
      .locator('div[tabindex="0"]')
      .filter({ hasText: /^Search Booking/ })
      .first();
    await elLocator.waitFor({ state: "visible", timeout: 10000 });
    await elLocator.focus();
    await pageRef.keyboard.press("Enter");
  }
}

async function fetchPNR(pnr, detail) {
  const pageRef = await ensureBrowser();
  const trace = {
    pnr,
    detail,
    startedAt: new Date().toISOString(),
    pageUrlStart: pageRef.url(),
    response: null,
  };

  try {
    await sleep(rand(2000, 5000));
    await pageRef.goto(MANAGE_BOOKING_URL, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    await pageRef.waitForTimeout(2000);

    const { pnrInput, detailInput } = await resolveFormInputs(pageRef);
    await pnrInput.waitFor({ state: "visible", timeout: 20000 });
    await detailInput.waitFor({ state: "visible", timeout: 20000 });

    await fillReactInput(pnrInput, String(pnr || "").trim().toUpperCase());
    await sleep(rand(200, 500));
    await fillReactInput(detailInput, String(detail || "").trim().toUpperCase());

    const waitResp = waitForSpicejetApiPayload(pageRef, 25000).catch(
      (err) => ({ __error: err })
    );

    await sleep(rand(500, 1200));
    await clickSearchBooking(pageRef);

    let apiResult = await waitResp;
    if (apiResult?.__error) {
      trace.waitForResponseError = apiResult.__error.message;
    }

    const apiFailed =
      apiResult?.__error ||
      !apiResult?.payload ||
      (apiResult?.status ?? 0) >= 500;

    if (!apiFailed) {
      trace.responseStatus = apiResult.status;
      trace.responseUrl    = apiResult.url;
      const domData = await scrapeBookingPageDOM(pageRef).catch(() => ({}));
      trace.response = apiResult.payload;
      trace.domData  = domData;
      trace.responseBodySnippet = String(apiResult.bodyText || "").slice(0, 3000);
      writeTrace(pnr, trace);
      return extractDataFromApi(apiResult.payload, pnr, detail, domData);
    }

    // Second chance: direct fetch
    let directResult = null;
    try {
      const fb = await fetchSpicejetBookingDirect(pageRef, pnr, detail);
      if (fb.status < 500 && fb.bodyText) {
        const parsed = normalizeResponsePayload(fb.bodyText);
        if (parsed) {
          directResult = {
            status: fb.status,
            url: fb.url,
            bodyText: fb.bodyText,
            payload: parsed,
          };
        }
      }
    } catch (_) {}

    if (directResult) {
      trace.responseStatus          = directResult.status;
      trace.responseUrl             = directResult.url;
      trace.usedDirectFetchFallback = true;
      const domData = await scrapeBookingPageDOM(pageRef).catch(() => ({}));
      trace.response = directResult.payload;
      trace.domData  = domData;
      writeTrace(pnr, trace);
      return extractDataFromApi(directResult.payload, pnr, detail, domData);
    }

    // Last resort: pure DOM scrape
    trace.usedDomScrape = true;
    const domData = await scrapeBookingPageDOM(pageRef).catch(() => ({}));
    trace.domData = domData;
    writeTrace(pnr, trace);

    if (!domData.pnr && !domData.booking_status && !domData.flight_number) {
      throw new Error(
        "API returned 500 and DOM scrape found no booking data — PNR may be invalid or session expired"
      );
    }

    return extractDataFromDOM(domData, pnr, detail);
  } catch (err) {
    writeTrace(pnr, {
      ...trace,
      error: err.message,
      doneAt: new Date().toISOString(),
    });
    return {
      success: false,
      error: err.message || "Unknown scraping error",
    };
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