'use strict';

const { chromium } = require('playwright');

const MANAGE_BOOKING_URL =
  'https://www.goindigo.in/account/my-bookings.html?linkNav=Find%20%26%20view%20booking%7CMy%20trips%7CTrips';

const HEADLESS = String(process.env.HEADLESS || 'false').toLowerCase() !== 'false';

const PNR_SELECTORS = [
  'input[name="pnr-booking-ref"]',
  'input[placeholder="PNR / Booking Reference"]',
  'input[placeholder="PNR/Booking Reference"]',
  'input[placeholder*="PNR"]',
  'input[maxlength="6"]',
];

const NAME_SELECTORS = [
  'input[name="email-last-name"]',
  'input[placeholder="Email ID / Last Name"]',
  'input[placeholder="Email/Last Name"]',
  'input[placeholder*="Last Name"]',
  'input[placeholder*="Email"]',
];

const NO_SHOW_CLICK_HERE_SELECTORS = [
  '.passenger-no-show-container__link',
  '.passenger-no-show-container button:has-text("Click Here")',
  'button:has-text("Click Here")',
];

const TOAST_MESSAGE_SELECTORS = [
  '.notifi-variation-container .desc',
  '.notifi-variation-container li.desc',
  '.notifi-variation-container .content li',
];

let browser = null;
let context = null;
let page = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPageStable(pageRef, timeoutMs = 6000) {
  try {
    await pageRef.waitForLoadState('domcontentloaded', { timeout: Math.min(4000, timeoutMs) });
  } catch (_) {}
  try {
    await pageRef.waitForLoadState('networkidle', { timeout: timeoutMs });
  } catch (_) {
    await sleep(300);
  }
}

async function ensureBrowser() {
  if (page && !page.isClosed()) return page;

  if (!browser) {
    browser = await chromium.launch({
      headless: HEADLESS,
      args: ['--disable-blink-features=AutomationControlled'],
    });
  }

  context = await browser.newContext({
    viewport: { width: 1366, height: 820 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
  });

  page = await context.newPage();
  page.setDefaultTimeout(25000);
  return page;
}

async function clickFirst(pageRef, selectors, timeout = 4000) {
  for (const selector of selectors) {
    try {
      const locator = pageRef.locator(selector).first();
      if (await locator.count()) {
        await locator.click({ timeout });
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function fillFirst(pageRef, selectors, value) {
  for (const selector of selectors) {
    try {
      const locator = pageRef.locator(selector).first();
      if (await locator.count()) {
        await locator.click({ timeout: 2500 });
        await locator.fill('');
        await locator.type(String(value || '').trim(), { delay: 25 });
        return true;
      }
    } catch (_) {}
  }
  return false;
}

async function getToastMessage(pageRef) {
  for (const selector of TOAST_MESSAGE_SELECTORS) {
    try {
      const locator = pageRef.locator(selector).first();
      await locator.waitFor({ state: 'visible', timeout: 5000 });
      const text = (await locator.innerText()).trim();
      if (text) return text;
    } catch (_) {}
  }
  return '';
}

async function waitForRefundToastMessage(pageRef, timeoutMs = 25000) {
  const started = Date.now();
  let lastSeen = '';

  while (Date.now() - started < timeoutMs) {
    const msg = await getToastMessage(pageRef);
    if (msg) {
      lastSeen = msg;
      const low = msg.toLowerCase();
      if (low.includes('refund') && low.includes('inr')) return msg;
    }
    await sleep(350);
  }

  return lastSeen;
}

async function waitForNoShowContainer(pageRef, timeoutMs = 30000) {
  const started = Date.now();
  const containerSelectors = [
    '.passenger-no-show-container',
    '.passenger-no-show-container__message',
    'text=Passenger(s) in this PNR is No Show',
  ];

  while (Date.now() - started < timeoutMs) {
    for (const sel of containerSelectors) {
      try {
        const loc = pageRef.locator(sel).first();
        if (await loc.count()) {
          const visible = await loc.isVisible().catch(() => false);
          if (visible) {
            await loc.scrollIntoViewIfNeeded().catch(() => {});
            await sleep(250);
            return true;
          }
        }
      } catch (_) {
        // keep trying
      }
    }

    await pageRef.mouse.wheel(0, 700).catch(() => {});
    await sleep(450);
  }
  return false;
}

function extractInrAmount(message) {
  const match = String(message || '').match(/INR\s*([0-9,]+(?:\.[0-9]{1,2})?)/i);
  return match ? match[1].replace(/,/g, '') : '';
}

function parseRefundFromItinerary(payload) {
  const data = payload?.data || payload || {};
  const tax = data?.indigoTaxRefund || {};
  const amountRaw = tax?.refundAmount;
  const amount = amountRaw == null ? '' : String(amountRaw).replace(/,/g, '');
  const errorText = String(tax?.errorInNoShowTaxRefund || '').trim();
  const isRefundProcessed = Boolean(tax?.isRefundProcessed);
  const responseFlag = tax?.response;
  const isToShowTaxRefund = tax?.isToShowTaxRefund;

  let status = '';
  if (isRefundProcessed || Number(amount) > 0) {
    status = 'PROCESSED';
  } else if (errorText) {
    status = 'API_ERROR';
  } else if (responseFlag === false || isToShowTaxRefund === false) {
    status = 'NOT_ELIGIBLE';
  } else {
    status = 'AMOUNT_NOT_FOUND';
  }

  return {
    refund_amount: Number.isFinite(Number(amount)) ? String(Number(amount)) : '',
    refund_status: status,
    error_text: errorText,
    raw: tax,
  };
}

async function fetchRefund(pnr, lastName) {
  const trace = {
    pnr,
    lastName,
    startedAt: new Date().toISOString(),
    toastMessage: '',
    refundApi: null,
    itineraryAfterClick: null,
    postClickCalls: [],
  };

  try {
    const pageRef = await ensureBrowser();
    await pageRef.goto(MANAGE_BOOKING_URL, { waitUntil: 'domcontentloaded' });
    await waitForPageStable(pageRef, 7000);

    const pnrOk = await fillFirst(pageRef, PNR_SELECTORS, String(pnr || '').toUpperCase());
    const nameOk = await fillFirst(pageRef, NAME_SELECTORS, String(lastName || '').toUpperCase());
    if (!pnrOk || !nameOk) {
      throw new Error('Could not find input fields for PNR/Last Name.');
    }

    const submitted = await clickFirst(pageRef, [
      'button:has-text("Get Started")',
      'button[title="Get Started"]',
      'button[type="submit"]',
    ]);
    if (!submitted) throw new Error('Get Started button not found.');

    await waitForPageStable(pageRef, 12000);
    const hasNoShowContainer = await waitForNoShowContainer(pageRef, 30000);
    if (!hasNoShowContainer) {
      throw new Error('No Show container not found.');
    }

    let latestItinerary = null;
    const onResponse = async (resp) => {
      try {
        const req = resp.request();
        const method = String(req.method() || '').toUpperCase();
        const url = String(resp.url() || '');
        const urlLow = url.toLowerCase();
        const resourceType = req.resourceType();
        if (!['xhr', 'fetch'].includes(resourceType)) return;
        if (!urlLow.includes('goindigo.in')) return;

        const row = {
          time: new Date().toISOString(),
          method,
          status: resp.status(),
          url,
        };

        if (trace.postClickCalls.length < 120) trace.postClickCalls.push(row);

        if (urlLow.includes('/v2/itinerary')) {
          let body = null;
          try {
            body = await resp.json();
          } catch (_) {
            body = null;
          }
          if (body && body.data) {
            latestItinerary = body;
            trace.itineraryAfterClick = {
              success: body?.success,
              bookingStatus: body?.data?.bookingDetails?.bookingStatus,
              indigoTaxRefund: body?.data?.indigoTaxRefund || null,
            };
          }
        }
      } catch (_) {
        // ignore per-response parsing errors
      }
    };

    pageRef.on('response', onResponse);

    const clickHereClicked = await clickFirst(pageRef, [
      ...NO_SHOW_CLICK_HERE_SELECTORS,
      '.passenger-no-show-container :text("Click Here")',
      'text=Click Here',
    ], 6000);
    if (!clickHereClicked) {
      pageRef.off('response', onResponse);
      throw new Error('No Show "Click Here" button not found.');
    }

    const waitUntil = Date.now() + 26000;
    while (Date.now() < waitUntil) {
      if (latestItinerary?.data?.indigoTaxRefund) break;
      await sleep(350);
    }

    trace.toastMessage = await waitForRefundToastMessage(pageRef, 25000);
    pageRef.off('response', onResponse);

    const seen403 = trace.postClickCalls.some(x => x.status === 403);
    const itineraryRefund = latestItinerary ? parseRefundFromItinerary(latestItinerary) : null;
    const toastAmount = extractInrAmount(trace.toastMessage);

    let refundAmount = '';
    let refundStatus = 'AMOUNT_NOT_FOUND';

    if (itineraryRefund) {
      refundAmount = itineraryRefund.refund_amount || '';
      refundStatus = itineraryRefund.refund_status || refundStatus;
      trace.refundApi = {
        source: 'itinerary',
        indigoTaxRefund: itineraryRefund.raw,
        errorText: itineraryRefund.error_text || '',
      };
    } else if (toastAmount) {
      refundAmount = toastAmount;
      refundStatus = 'PROCESSED';
      trace.refundApi = { source: 'toast' };
    }

    if (seen403 && !refundAmount) {
      refundStatus = 'FORBIDDEN_403';
    } else if (!refundAmount && String(trace.toastMessage || '').toLowerCase().includes('something went wrong')) {
      refundStatus = 'TOAST_ERROR';
    }

    return {
      success: true,
      data: {
        pnr,
        last_name: lastName,
        refund_amount: refundAmount || '',
        refund_status: refundStatus,
        raw_json: JSON.stringify(trace),
      },
    };
  } catch (err) {
    return {
      success: false,
      error: String(err && err.message ? err.message : 'Refund flow failed'),
    };
  }
}

async function closeBrowser() {
  try {
    if (page && !page.isClosed()) await page.close();
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
  fetchRefund,
  closeBrowser,
};
