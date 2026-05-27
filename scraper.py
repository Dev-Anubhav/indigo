"""
IndiGo Refund Scraper — Camoufox Edition
=========================================
Reverse-engineered from live session capture.

Flow:
  1. Launch Camoufox (stealth Firefox)
  2. Navigate to my-bookings page  →  Akamai challenge auto-solved by real browser
  3. Fill PNR + Last Name → click Get Started
  4. POST /v2/Booking/retrieve fires automatically (browser handles encryption)
  5. Redirect to /book/itinerary.html
  6. POST /v2/Itinerary fires (loads booking into session)
  7. Click "Click Here" refund button
  8. POST /v1/itinerary/noshowrefund fires → {"success": true}
  9. Scrape result and return

Install:
  pip install camoufox[geoip] openpyxl
  python -m camoufox fetch

Usage:
  python refundScraper.py
  OR import and call process_refund(pnr, last_name)
"""

import asyncio
import json
import logging
import random
import sys
import time
import traceback
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional

from camoufox.async_api import AsyncCamoufox

# ── Logging ──────────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler("refund_scraper.log", encoding="utf-8"),
    ],
)
log = logging.getLogger("refundScraper")

# ── Config ────────────────────────────────────────────────────────────────────

BASE_URL        = "https://www.goindigo.in"
BOOKINGS_URL    = f"{BASE_URL}/account/my-bookings.html?linkNav=Find%20%26%20view%20booking%7CMy%20trips%7CTrips"
ITINERARY_URL   = f"{BASE_URL}/book/itinerary.html"

# Timeouts (seconds)
PAGE_LOAD_TIMEOUT   = 30_000   # ms for Playwright waits
ELEMENT_TIMEOUT     = 15_000
NETWORK_TIMEOUT     = 20_000

# Human-like delays (seconds)
DELAY_AFTER_LOAD    = (2.0, 4.0)
DELAY_AFTER_TYPE    = (0.3, 0.8)
DELAY_BETWEEN_KEYS  = (0.05, 0.15)
DELAY_AFTER_CLICK   = (1.5, 3.5)
DELAY_BETWEEN_JOBS  = (5.0, 10.0)

# Selectors — derived from page structure
SEL_PNR_INPUT       = "input[placeholder*='Booking Ref'], input[id*='pnr'], input[name*='pnr'], input[placeholder*='PNR']"
SEL_LASTNAME_INPUT  = "input[placeholder*='Last Name'], input[placeholder*='last name'], input[name*='lastName']"
SEL_GET_STARTED_BTN = "button:has-text('Get Started'), button:has-text('GET STARTED')"
SEL_RETRIEVE_BTN    = "button:has-text('Retrieve Itinerary'), button:has-text('RETRIEVE ITINERARY')"
SEL_REFUND_BTN      = "button:has-text('Click Here'), a:has-text('Click Here')"
SEL_PNR_CONFIRM     = ".confirmation-banner__container--textArea__dateTimePnr__prn, .booking-info-container-transaction-pnr-value"
SEL_PASSENGER       = ".passenger-detail__wrapper"
SEL_SUCCESS_MSG     = "text=success, text=refund, text=processed"

# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class RefundJob:
    pnr: str
    last_name: str
    index: int = 0

@dataclass
class RefundResult:
    pnr: str
    last_name: str
    success: bool
    message: str
    api_response: Optional[dict] = None
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    error: Optional[str] = None

# ── Helpers ───────────────────────────────────────────────────────────────────

async def human_delay(lo: float, hi: float):
    """Randomised sleep to mimic human timing."""
    await asyncio.sleep(random.uniform(lo, hi))


async def human_type(element, text: str):
    """Type character by character with random delays."""
    await element.click()
    await element.fill("")          # clear first
    for char in text:
        await element.type(char)
        await human_delay(*DELAY_BETWEEN_KEYS)


async def wait_and_click(page, selector: str, timeout: int = ELEMENT_TIMEOUT):
    """Wait for an element then click it."""
    el = await page.wait_for_selector(selector, timeout=timeout, state="visible")
    await el.scroll_into_view_if_needed()
    await human_delay(0.3, 0.7)
    await el.click()
    return el


async def intercept_api_response(page, url_fragment: str, timeout: float = 15.0) -> Optional[dict]:
    """
    Wait for a specific API response by intercepting network events.
    Returns parsed JSON body or None on timeout.
    """
    result = {}
    done   = asyncio.Event()

    async def on_response(response):
        if url_fragment in response.url:
            try:
                body = await response.json()
                result["data"] = body
            except Exception:
                result["data"] = {"raw": await response.text()}
            done.set()

    page.on("response", on_response)
    try:
        await asyncio.wait_for(done.wait(), timeout=timeout)
        return result.get("data")
    except asyncio.TimeoutError:
        return None
    finally:
        page.remove_listener("response", on_response)

# ── Core scraper ──────────────────────────────────────────────────────────────

async def process_refund(
    pnr: str,
    last_name: str,
    browser_context=None,
    existing_page=None,
) -> RefundResult:
    """
    Process a single PNR refund.

    If browser_context is provided the page is opened inside that context
    (reuses Akamai cookies). Otherwise a standalone Camoufox instance is used.
    """
    pnr       = pnr.strip().upper()
    last_name = last_name.strip()
    log.info(f"[{pnr}] Starting refund for last_name={last_name!r}")

    page = existing_page

    try:
        # ── Step 1: Navigate to My Bookings ──────────────────────────────────
        log.info(f"[{pnr}] → Navigating to My Bookings page")
        await page.goto(BOOKINGS_URL, wait_until="domcontentloaded", timeout=PAGE_LOAD_TIMEOUT)
        await human_delay(*DELAY_AFTER_LOAD)

        # Let Akamai scripts fully execute (they fire several POSTs)
        await page.wait_for_load_state("networkidle", timeout=PAGE_LOAD_TIMEOUT)
        await human_delay(1.0, 2.0)

        # ── Step 2: Fill PNR ─────────────────────────────────────────────────
        log.info(f"[{pnr}] → Filling PNR field")
        pnr_el = await page.wait_for_selector(SEL_PNR_INPUT, timeout=ELEMENT_TIMEOUT, state="visible")
        await human_type(pnr_el, pnr)
        await human_delay(*DELAY_AFTER_TYPE)

        # ── Step 3: Fill Last Name ────────────────────────────────────────────
        log.info(f"[{pnr}] → Filling Last Name field")
        ln_el = await page.wait_for_selector(SEL_LASTNAME_INPUT, timeout=ELEMENT_TIMEOUT, state="visible")
        await human_type(ln_el, last_name)
        await human_delay(*DELAY_AFTER_TYPE)

        # ── Step 4: Click Get Started — intercept /v2/Booking/retrieve ────────
        log.info(f"[{pnr}] → Clicking Get Started")

        retrieve_task = asyncio.create_task(
            intercept_api_response(page, "Booking/retrieve", timeout=20.0)
        )

        await wait_and_click(page, SEL_GET_STARTED_BTN)
        await human_delay(*DELAY_AFTER_CLICK)

        retrieve_resp = await retrieve_task
        log.info(f"[{pnr}] Booking/retrieve response: {retrieve_resp}")

        if not retrieve_resp or not retrieve_resp.get("data", {}).get("success"):
            return RefundResult(
                pnr=pnr,
                last_name=last_name,
                success=False,
                message="Booking retrieve failed — PNR or last name incorrect",
                api_response=retrieve_resp,
            )

        # ── Step 5: Wait for redirect to /book/itinerary.html ─────────────────
        log.info(f"[{pnr}] → Waiting for itinerary page")
        await page.wait_for_url("**/book/itinerary.html**", timeout=PAGE_LOAD_TIMEOUT)
        await page.wait_for_load_state("networkidle", timeout=PAGE_LOAD_TIMEOUT)
        await human_delay(*DELAY_AFTER_LOAD)

        # Confirm booking loaded — PNR visible on page
        log.info(f"[{pnr}] → Confirming booking details loaded")
        try:
            await page.wait_for_selector(SEL_PNR_CONFIRM, timeout=ELEMENT_TIMEOUT)
            await page.wait_for_selector(SEL_PASSENGER, timeout=ELEMENT_TIMEOUT)
            log.info(f"[{pnr}] ✓ Booking details confirmed on page")
        except Exception:
            log.warning(f"[{pnr}] Could not confirm booking details selectors — proceeding anyway")

        await human_delay(1.5, 3.0)

        # ── Step 6: Click "Click Here" for refund — intercept noshowrefund ────
        log.info(f"[{pnr}] → Looking for refund button")

        refund_task = asyncio.create_task(
            intercept_api_response(page, "noshowrefund", timeout=20.0)
        )

        try:
            await wait_and_click(page, SEL_REFUND_BTN, timeout=ELEMENT_TIMEOUT)
        except Exception as e:
            # Button may not exist if booking is not eligible
            log.warning(f"[{pnr}] Refund button not found: {e}")
            refund_task.cancel()
            return RefundResult(
                pnr=pnr,
                last_name=last_name,
                success=False,
                message="Refund button not found — booking may not be eligible for no-show refund",
            )

        await human_delay(*DELAY_AFTER_CLICK)

        refund_resp = await refund_task
        log.info(f"[{pnr}] noshowrefund response: {refund_resp}")

        if refund_resp and refund_resp.get("data", {}).get("success"):
            log.info(f"[{pnr}] ✅ REFUND SUCCESS")
            return RefundResult(
                pnr=pnr,
                last_name=last_name,
                success=True,
                message=refund_resp.get("data", {}).get("message", "success"),
                api_response=refund_resp,
            )
        else:
            log.warning(f"[{pnr}] ❌ REFUND FAILED — response: {refund_resp}")
            return RefundResult(
                pnr=pnr,
                last_name=last_name,
                success=False,
                message="Refund API returned non-success",
                api_response=refund_resp,
            )

    except Exception as exc:
        log.error(f"[{pnr}] Exception: {exc}")
        log.debug(traceback.format_exc())
        return RefundResult(
            pnr=pnr,
            last_name=last_name,
            success=False,
            message=f"Exception: {type(exc).__name__}",
            error=str(exc),
        )


# ── Batch runner ──────────────────────────────────────────────────────────────

async def run_batch(jobs: list[RefundJob], output_path: str = "refund_results.json") -> list[RefundResult]:
    """
    Run all refund jobs sequentially inside a single Camoufox browser session.
    One browser → one Akamai cookie session → all jobs share it.
    """
    results: list[RefundResult] = []

    log.info(f"Starting batch of {len(jobs)} jobs")
    log.info("=" * 60)

    async with AsyncCamoufox(
        headless=False,          # Set True once you've confirmed it works headlessly
        geoip=True,              # Auto-detect locale/timezone from your real IP
        os="macos",              # Match what the session shows (macOS)
        humanize=True,           # Enable human-like mouse/scroll behaviour
        i_know_what_im_doing=True,
    ) as browser:

        # Open one persistent page — reuse across all jobs
        page = await browser.new_page()

        # Warm up: visit homepage first so Akamai sees normal browsing behaviour
        log.info("Warming up — visiting homepage...")
        await page.goto(BASE_URL, wait_until="domcontentloaded", timeout=PAGE_LOAD_TIMEOUT)
        await page.wait_for_load_state("networkidle", timeout=PAGE_LOAD_TIMEOUT)
        await human_delay(3.0, 5.0)
        log.info("Warm-up complete")

        for i, job in enumerate(jobs):
            job.index = i + 1
            log.info(f"\n[Job {job.index}/{len(jobs)}] PNR={job.pnr}")

            result = await process_refund(
                pnr=job.pnr,
                last_name=job.last_name,
                existing_page=page,
            )
            results.append(result)

            # Log result
            status = "✅ SUCCESS" if result.success else "❌ FAILED"
            log.info(f"[Job {job.index}] {status}: {result.message}")

            # Save incremental results after each job
            _save_results(results, output_path)

            # Human-like pause between jobs (skip after last)
            if i < len(jobs) - 1:
                delay = random.uniform(*DELAY_BETWEEN_JOBS)
                log.info(f"Waiting {delay:.1f}s before next job...")
                await asyncio.sleep(delay)

        await page.close()

    # Final save
    _save_results(results, output_path)
    _print_summary(results)
    return results


def _save_results(results: list[RefundResult], path: str):
    data = [
        {
            "pnr":          r.pnr,
            "last_name":    r.last_name,
            "success":      r.success,
            "message":      r.message,
            "api_response": r.api_response,
            "timestamp":    r.timestamp,
            "error":        r.error,
        }
        for r in results
    ]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _print_summary(results: list[RefundResult]):
    total   = len(results)
    success = sum(1 for r in results if r.success)
    failed  = total - success
    log.info("\n" + "=" * 60)
    log.info("REFUND BATCH SUMMARY")
    log.info("=" * 60)
    log.info(f"  Total  : {total}")
    log.info(f"  Success: {success}")
    log.info(f"  Failed : {failed}")
    log.info("=" * 60)
    for r in results:
        icon = "✅" if r.success else "❌"
        log.info(f"  {icon}  {r.pnr:10s}  {r.last_name:20s}  {r.message}")
    log.info("=" * 60)


# ── Excel input support ───────────────────────────────────────────────────────

def load_jobs_from_excel(path: str) -> list[RefundJob]:
    """
    Load jobs from an Excel file.
    Expected columns: PNR (or pnr / Booking Ref), LastName (or last_name / Last Name)
    """
    try:
        import openpyxl
    except ImportError:
        log.error("openpyxl not installed. Run: pip install openpyxl")
        sys.exit(1)

    wb   = openpyxl.load_workbook(path)
    ws   = wb.active
    rows = list(ws.iter_rows(values_only=True))

    if not rows:
        log.error("Excel file is empty")
        sys.exit(1)

    # Auto-detect column positions from header row
    header = [str(c).strip().lower() if c else "" for c in rows[0]]

    pnr_aliases      = {"pnr", "booking ref", "booking reference", "record locator"}
    lastname_aliases = {"last name", "lastname", "last_name", "surname", "family name"}

    pnr_col = ln_col = None
    for idx, h in enumerate(header):
        if h in pnr_aliases:
            pnr_col = idx
        if h in lastname_aliases:
            ln_col = idx

    if pnr_col is None or ln_col is None:
        log.error(f"Could not find PNR/LastName columns. Header found: {rows[0]}")
        log.error("Expected columns: PNR, Last Name  (or similar)")
        sys.exit(1)

    jobs = []
    for row in rows[1:]:
        pnr  = str(row[pnr_col]).strip() if row[pnr_col] else ""
        ln   = str(row[ln_col]).strip()  if row[ln_col]  else ""
        if pnr and ln and pnr.lower() != "none":
            jobs.append(RefundJob(pnr=pnr, last_name=ln))

    log.info(f"Loaded {len(jobs)} jobs from {path}")
    return jobs


# ── CLI / Entry point ─────────────────────────────────────────────────────────

async def main():
    import argparse

    parser = argparse.ArgumentParser(description="IndiGo No-Show Refund Scraper")
    parser.add_argument("--excel",  type=str, help="Path to Excel file with PNR + Last Name columns")
    parser.add_argument("--pnr",    type=str, help="Single PNR to process")
    parser.add_argument("--name",   type=str, help="Last name for single PNR")
    parser.add_argument("--output", type=str, default="refund_results.json", help="Output JSON file path")
    args = parser.parse_args()

    if args.excel:
        jobs = load_jobs_from_excel(args.excel)
    elif args.pnr and args.name:
        jobs = [RefundJob(pnr=args.pnr, last_name=args.name)]
    else:
        # Demo mode — edit these
        jobs = [
            RefundJob(pnr="ABC123", last_name="SHARMA"),
            RefundJob(pnr="XYZ789", last_name="PATEL"),
        ]
        log.warning("No --excel or --pnr/--name provided. Running with demo data.")
        log.warning("Edit the jobs list in main() or use: python refundScraper.py --pnr ABC123 --name SHARMA")

    results = await run_batch(jobs, output_path=args.output)
    return results


if __name__ == "__main__":
    asyncio.run(main())