'use strict';

require('dotenv').config();
const ExcelJS = require('exceljs');
const path    = require('path');
const fs      = require('fs');
const db      = require('./db');
const logger  = require('./logger');

const OUTPUT_PATH = process.env.OUTPUT_EXCEL || './output/results.xlsx';

function splitIsoDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return { date: '', time: '' };
  const dt = new Date(raw);
  if (!Number.isNaN(dt.getTime())) {
    const iso = dt.toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[T\s](\d{2}:\d{2})/);
  if (m) return { date: m[1], time: m[2] };
  return { date: raw.slice(0, 10), time: '' };
}

function parseRawJson(rawJson) {
  if (!rawJson) return null;
  try {
    return JSON.parse(rawJson);
  } catch (_) {
    return null;
  }
}

function mapLiftStatusCode(code) {
  const c = Number(code);
  const map = {
    0: 'NOT_CHECKED_IN',
    1: 'CHECKED_IN',
    2: 'BOARDED',
    3: 'NO_SHOW',
    4: 'OFFLOADED',
  };
  if (Number.isNaN(c)) return String(code || '').trim();
  return map[c] || `LIFT_${c}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPICEJET: build one row per passenger
// Handles both sources:
//   source="api"  → parsed.booking has API JSON, parsed.domData has DOM fields
//   source="dom"  → parsed.domData has everything (no API JSON)
// ─────────────────────────────────────────────────────────────────────────────
function buildSpiceJetPassengerRows(job, parsed) {
  const source  = parsed?.source || 'api';
  const domData = parsed?.domData || {};
  const booking = parsed?.booking || {};

  // ── DOM-only path ─────────────────────────────────────────────────────────
  if (source === 'dom') {
    const passengers = Array.isArray(domData.passengers) ? domData.passengers : [];
    if (!passengers.length) {
      return [buildSpiceJetBaseRow(job, domData, {}, 0)];
    }
    return passengers.map((p, idx) =>
      buildSpiceJetBaseRow(job, domData, p, idx)
    );
  }

  // ── API path (enriched with domData) ─────────────────────────────────────
  const passengerMap = booking?.passengers && typeof booking.passengers === 'object'
    ? booking.passengers : {};
  const firstJourney = Array.isArray(booking?.journeys) ? booking.journeys[0] || {} : {};
  const firstSegment = firstJourney?.segments?.[0] || {};
  const paxSegmentMap = firstSegment?.passengerSegment && typeof firstSegment.passengerSegment === 'object'
    ? firstSegment.passengerSegment : {};
  const designator = firstJourney?.designator || firstSegment?.designator || {};
  const dep = splitIsoDateTime(designator?.departure || '');
  const arr = splitIsoDateTime(designator?.arrival   || '');
  const identifier = firstSegment?.identifier || {};

  const keys = Object.keys(passengerMap);
  if (!keys.length) {
    return [buildSpiceJetBaseRow(job, domData, {}, 0)];
  }

  // Build seat map from domData.passengers (indexed by order)
  const domPassengers = Array.isArray(domData.passengers) ? domData.passengers : [];

  return keys.map((key, idx) => {
    const p      = passengerMap[key] || {};
    const name   = p?.name || {};
    const paxSeg = paxSegmentMap[key] || {};
    const paxName = [name.title, name.first, name.middle, name.last]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    const domPax = domPassengers[idx] || {};

    return {
      pnr:            job.pnr,
      last_name:      job.last_name,
      ticket_number:  job.ticket_number  || domData.ticket_number  || '',
      passenger_name: paxName            || domPax.name            || '',
      seat_number:    domPax.seat        || '',
      flight_number:  job.flight_number  || [identifier?.carrierCode, identifier?.identifier].filter(Boolean).join(' ') || '',
      origin:         job.origin         || designator?.origin      || domData.origin      || '',
      destination:    job.destination    || designator?.destination || domData.destination || '',
      travel_date:    dep.date           || job.travel_date         || domData.travel_date  || '',
      departure_time: dep.time           || job.departure_time      || domData.departure_time || '',
      arrival_time:   arr.time           || job.arrival_time        || domData.arrival_time   || '',
      duration:       domData.duration   || '',
      terminal:       domData.terminal   || '',
      booking_status: job.booking_status || domData.booking_status  || '',
      booking_date:   job.booking_date   || domData.booking_date    || '',
      payment_status: job.payment_status || domData.payment_status  || '',
      travel_status:  job.travel_status  || domData.flight_status   || '',
      lift_status:    mapLiftStatusCode(paxSeg?.liftStatus) || job.lift_status || '',
      fare_amount:    job.fare_amount    || domData.total_amount    || '',
      fare_breakdown: job.fare_breakdown || domData.fare_breakdown  || '',
      source:         source,
    };
  });
}

// Helper: build a single row from domData + optional passenger object
function buildSpiceJetBaseRow(job, domData, pax, idx) {
  return {
    pnr:            job.pnr,
    last_name:      job.last_name,
    ticket_number:  job.ticket_number  || domData.ticket_number  || '',
    passenger_name: pax.name           || job.passenger_name     || '',
    seat_number:    pax.seat           || '',
    flight_number:  job.flight_number  || domData.flight_number  || '',
    origin:         job.origin         || domData.origin         || '',
    destination:    job.destination    || domData.destination    || '',
    travel_date:    job.travel_date    || domData.travel_date    || '',
    departure_time: job.departure_time || domData.departure_time || '',
    arrival_time:   job.arrival_time   || domData.arrival_time   || '',
    duration:       domData.duration   || '',
    terminal:       domData.terminal   || '',
    booking_status: job.booking_status || domData.booking_status || '',
    booking_date:   job.booking_date   || domData.booking_date   || '',
    payment_status: job.payment_status || domData.payment_status || '',
    travel_status:  job.travel_status  || domData.flight_status  || '',
    lift_status:    job.lift_status    || '',
    fare_amount:    job.fare_amount    || domData.total_amount   || '',
    fare_breakdown: job.fare_breakdown || domData.fare_breakdown || '',
    source:         'dom',
  };
}

function buildAkasaAirPassengerRows(job, parsed) {
  const booking = parsed?.booking || {};
  const passengers = Array.isArray(booking?.passengers) ? booking.passengers : [];
  const firstJourney = Array.isArray(booking?.journeys) ? booking.journeys[0] || {} : {};
  const firstSegment = firstJourney?.segments?.[0] || {};

  const paxSegmentMap = {};
  if (Array.isArray(firstSegment?.passengerSegment)) {
    for (const ps of firstSegment.passengerSegment) {
      if (ps.passengerKey) {
        paxSegmentMap[ps.passengerKey] = ps;
      }
    }
  }

  const designator = firstJourney?.designator || firstSegment?.designator || {};
  const dep = splitIsoDateTime(designator?.departure || '');
  const arr = splitIsoDateTime(designator?.arrival   || '');
  const identifier = firstSegment?.identifier || {};

  if (!passengers.length) {
    return [{
      pnr:            job.pnr,
      last_name:      job.last_name,
      ticket_number:  '',
      passenger_name: '',
      seat_number:    '',
      flight_number:  job.flight_number  || [identifier?.carrierCode, identifier?.identifier].filter(Boolean).join(' ') || '',
      origin:         job.origin         || designator?.origin      || '',
      destination:    job.destination    || designator?.destination || '',
      travel_date:    dep.date           || job.travel_date         || '',
      departure_time: dep.time           || job.departure_time      || '',
      arrival_time:   arr.time           || job.arrival_time        || '',
      duration:       '',
      terminal:       firstSegment?.legs?.[0]?.legInfo?.departureTerminal || '',
      booking_status: job.booking_status || booking?.info?.status || '',
      booking_date:   booking?.info?.bookedDate || '',
      payment_status: booking?.info?.paidStatus || '',
      travel_status:  job.travel_status  || '',
      lift_status:    job.lift_status    || '',
      fare_amount:    job.fare_amount    || booking?.breakdown?.totalAmount || '',
      fare_breakdown: '',
      source:         'api',
    }];
  }

  return passengers.map((p) => {
    const name   = p?.name || {};
    const paxSeg = paxSegmentMap[p.passengerKey] || {};
    const seat   = Array.isArray(paxSeg?.seats) ? paxSeg.seats[0]?.unitDesignator || '' : '';
    const paxName = [name.title, name.first, name.middle, name.last]
      .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();

    return {
      pnr:            job.pnr,
      last_name:      job.last_name,
      ticket_number:  '',
      passenger_name: paxName,
      seat_number:    seat,
      flight_number:  job.flight_number  || [identifier?.carrierCode, identifier?.identifier].filter(Boolean).join(' ') || '',
      origin:         job.origin         || designator?.origin      || '',
      destination:    job.destination    || designator?.destination || '',
      travel_date:    dep.date           || job.travel_date         || '',
      departure_time: dep.time           || job.departure_time      || '',
      arrival_time:   arr.time           || job.arrival_time        || '',
      duration:       '',
      terminal:       firstSegment?.legs?.[0]?.legInfo?.departureTerminal || '',
      booking_status: job.booking_status || booking?.info?.status || '',
      booking_date:   booking?.info?.bookedDate || '',
      payment_status: booking?.info?.paidStatus || '',
      travel_status:  job.travel_status  || '',
      lift_status:    paxSeg?.liftStatus || job.lift_status         || '',
      fare_amount:    job.fare_amount    || booking?.breakdown?.totalAmount || '',
      fare_breakdown: '',
      source:         'api',
    };
  });
}

function buildPassengerRows(job) {
  const parsed = parseRawJson(job.raw_json);
  if (parsed?.airline === 'spicejet') {
    return buildSpiceJetPassengerRows(job, parsed);
  }
  if (parsed?.airline === 'akasaair') {
    return buildAkasaAirPassengerRows(job, parsed);
  }

  // ── IndiGo / other airlines (unchanged) ───────────────────────────────────
  const itinerary    = parsed?.itinerary || null;
  const visibleGuests = Array.isArray(parsed?.visibleGuests) ? parsed.visibleGuests : [];
  const data         = itinerary?.data || null;
  const passengers   = Array.isArray(data?.passengers) ? data.passengers : [];
  const firstJourney = data?.journeysDetail?.[0] || data?.journeys?.[0] || {};
  const firstSegment = firstJourney?.segments?.[0] || {};
  const firstSegmentDetails = firstSegment?.segmentDetails || firstSegment?.legDetails || firstSegment?.designator || {};

  if (!passengers.length) {
    return [{
      pnr:            job.pnr,
      last_name:      job.last_name,
      ticket_number:  '',
      passenger_name: '',
      seat_number:    '',
      flight_number:  job.flight_number  || '',
      origin:         job.origin         || '',
      destination:    job.destination    || '',
      travel_date:    job.travel_date    || '',
      departure_time: job.departure_time || '',
      arrival_time:   job.arrival_time   || '',
      duration:       '',
      terminal:       '',
      booking_status: job.booking_status || '',
      booking_date:   '',
      payment_status: '',
      travel_status:  job.travel_status  || '',
      lift_status:    job.lift_status    || '',
      fare_amount:    job.fare_amount    || '',
      fare_breakdown: '',
      source:         'api',
    }];
  }

  return passengers.map((p) => {
    const visibleGuest  = visibleGuests[passengers.indexOf(p)] || {};
    const aixPaxSeg     = firstSegment?.passengerSegment?.[p?.passengerKey] || {};
    const paxSeg        = p?.seatsAndSsrs?.journeys?.[0]?.segments?.[0] || aixPaxSeg || {};
    const paxDesignator = paxSeg?.designator || {};
    const departureRaw  =
      paxDesignator?.departure ||
      firstSegmentDetails?.departure ||
      firstSegment?.designator?.departure || '';
    const { date, time } = splitIsoDateTime(departureRaw);
    const liftStatus = String(
      visibleGuest?.onward_status ||
      visibleGuest?.status_text   ||
      paxSeg?.liftStatus          ||
      p?.liftStatus               || ''
    ).trim() || (job.lift_status || '');

    return {
      pnr:            job.pnr,
      last_name:      job.last_name,
      ticket_number:  '',
      passenger_name: visibleGuest?.name || '',
      seat_number:    '',
      flight_number:  job.flight_number  || '',
      origin:         job.origin         || firstSegmentDetails?.origin      || '',
      destination:    job.destination    || firstSegmentDetails?.destination || '',
      travel_date:    date               || job.travel_date    || '',
      departure_time: time               || job.departure_time || '',
      arrival_time:   job.arrival_time   || '',
      duration:       '',
      terminal:       '',
      booking_status: job.booking_status || data?.bookingDetails?.bookingStatus || '',
      booking_date:   '',
      payment_status: '',
      travel_status:  job.travel_status  || '',
      lift_status:    liftStatus,
      fare_amount:    job.fare_amount    || '',
      fare_breakdown: '',
      source:         'api',
    };
  });
}

async function exportExcel() {
  const outPath = path.resolve(OUTPUT_PATH);
  const outDir  = path.dirname(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const stats    = db.getStats();
  const doneJobs = db.getAllDone();
  const failJobs = db.getAllFailed();

  console.log(`\n📊 Exporting results...`);
  console.log(`   Done   : ${doneJobs.length}`);
  console.log(`   Failed : ${failJobs.length}\n`);

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'PNR Scraper';
  workbook.created = new Date();

  // ── Sheet 1: Results ───────────────────────────────────────────────────────
  const ws1 = workbook.addWorksheet('Results', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws1.columns = [
    { header: 'PNR',             key: 'pnr',            width: 14 },
    { header: 'Last Name',       key: 'last_name',      width: 18 },
    { header: 'Ticket Number',   key: 'ticket_number',  width: 16 },
    { header: 'Passenger Name',  key: 'passenger_name', width: 28 },
    { header: 'Seat',            key: 'seat_number',    width: 10 },
    { header: 'Flight',          key: 'flight_number',  width: 12 },
    { header: 'Origin',          key: 'origin',         width: 10 },
    { header: 'Destination',     key: 'destination',    width: 12 },
    { header: 'Travel Date',     key: 'travel_date',    width: 14 },
    { header: 'Dep Time',        key: 'departure_time', width: 12 },
    { header: 'Arr Time',        key: 'arrival_time',   width: 12 },
    { header: 'Terminal',        key: 'terminal',       width: 12 },
    { header: 'Booking Status',  key: 'booking_status', width: 16 },
    { header: 'Booking Date',    key: 'booking_date',   width: 16 },
    { header: 'Payment Status',  key: 'payment_status', width: 16 },
    { header: 'Lift Status',     key: 'lift_status',    width: 18 },
    { header: 'Fare Amount',     key: 'fare_amount',    width: 14 },
  ];

  const headerRow1 = ws1.getRow(1);
  headerRow1.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow1.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  headerRow1.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow1.height    = 22;

  let resultRowCount = 0;
  for (const job of doneJobs) {
    const passengerRows = buildPassengerRows(job);
    for (const item of passengerRows) {
      const row = ws1.addRow(item);
      resultRowCount += 1;

      // Booking status color
      const statusCell = row.getCell('booking_status');
      const statusUpper = String(item.booking_status || '').toUpperCase();
      if (statusUpper === 'CONFIRMED') {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } };
        statusCell.font = { color: { argb: 'FF155724' } };
      } else if (statusUpper === 'CANCELLED') {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7DA' } };
        statusCell.font = { color: { argb: 'FF721C24' } };
      } else if (statusUpper === 'COMPLETED') {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD1ECF1' } };
        statusCell.font = { color: { argb: 'FF0C5460' } };
      }

      // Payment status color
      const payCell = row.getCell('payment_status');
      const payUpper = String(item.payment_status || '').toUpperCase();
      if (payUpper === 'PAID' || payUpper === 'PAIDINFULL') {
        payCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } };
        payCell.font = { color: { argb: 'FF155724' } };
      }

      // Alternate row background
      if (row.number % 2 === 0) {
        row.eachCell({ includeEmpty: true }, (cell) => {
          if (!cell.fill || cell.fill?.fgColor?.argb === 'FFFFFFFF') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FA' } };
          }
        });
      }
    }
  }

  ws1.autoFilter = { from: 'A1', to: 'Q1' };

  // ── Sheet 2: Failed ────────────────────────────────────────────────────────
  const ws2 = workbook.addWorksheet('Failed Records');
  ws2.columns = [
    { header: 'PNR',          key: 'pnr',               width: 14 },
    { header: 'Last Name',    key: 'last_name',          width: 18 },
    { header: 'Error',        key: 'error_msg',          width: 50 },
    { header: 'Retry Count',  key: 'retry_count',        width: 14 },
    { header: 'Last Tried',   key: 'last_attempted_at',  width: 20 },
  ];
  const hdr2 = ws2.getRow(1);
  hdr2.font   = { bold: true, color: { argb: 'FFFFFFFF' } };
  hdr2.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8B0000' } };
  hdr2.height = 22;
  for (const job of failJobs) {
    ws2.addRow({
      pnr:               job.pnr,
      last_name:         job.last_name,
      error_msg:         job.error_msg           || '',
      retry_count:       job.retry_count         || 0,
      last_attempted_at: job.last_attempted_at   || '',
    });
  }

  // ── Sheet 3: Summary ───────────────────────────────────────────────────────
  const ws3 = workbook.addWorksheet('Summary');
  ws3.getColumn(1).width = 24;
  ws3.getColumn(2).width = 16;
  const summaryData = [
    ['Generated At',   new Date().toLocaleString('en-IN')],
    ['Total Records',  stats.total],
    ['Completed',      stats.done],
    ['Failed',         stats.failed],
    ['Pending/Retry',  stats.pending + stats.retry],
    ['Success Rate',   stats.total > 0
      ? ((stats.done / stats.total) * 100).toFixed(1) + '%'
      : '0%'],
  ];
  for (const [label, value] of summaryData) {
    const row = ws3.addRow([label, value]);
    row.getCell(1).font = { bold: true };
  }

  await workbook.xlsx.writeFile(outPath);

  console.log(`✅ Excel exported to: ${outPath}`);
  console.log(`   Results sheet : ${resultRowCount} rows`);
  console.log(`   Failed sheet  : ${failJobs.length} rows\n`);
}

exportExcel().catch(err => {
  logger.error('Export failed:', err);
  process.exit(1);
});