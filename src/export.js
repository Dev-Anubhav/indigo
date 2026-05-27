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

function buildPassengerRows(job) {
  const parsed = parseRawJson(job.raw_json);
  const itinerary = parsed?.itinerary || null;
  const data = itinerary?.data || null;
  const passengers = Array.isArray(data?.passengers) ? data.passengers : [];
  const firstJourney = data?.journeysDetail?.[0] || data?.journeys?.[0] || {};
  const firstSegment = firstJourney?.segments?.[0] || {};
  const firstSegmentDetails = firstSegment?.segmentDetails || firstSegment?.legDetails || firstSegment?.designator || {};

  if (!passengers.length) {
    return [{
      pnr: job.pnr,
      last_name: job.last_name,
      origin: job.origin || '',
      destination: job.destination || '',
      travel_date: job.travel_date || '',
      departure_time: job.departure_time || '',
      booking_status: job.booking_status || '',
      lift_status: job.lift_status || '',
    }];
  }

  return passengers.map((p) => {
    const aixPaxSeg = firstSegment?.passengerSegment?.[p?.passengerKey] || {};
    const paxSeg = p?.seatsAndSsrs?.journeys?.[0]?.segments?.[0] || aixPaxSeg || {};
    const paxDesignator = paxSeg?.designator || {};
    const departureRaw =
      paxDesignator?.departure ||
      firstSegmentDetails?.departure ||
      firstSegment?.designator?.departure ||
      '';
    const { date, time } = splitIsoDateTime(departureRaw);

    const liftStatus =
      String(
        paxSeg?.liftStatus ||
        p?.liftStatus ||
        ''
      )
        .trim() || (job.lift_status || '');

    return {
      pnr: job.pnr,
      last_name: job.last_name,
      origin: job.origin || firstSegmentDetails?.origin || '',
      destination: job.destination || firstSegmentDetails?.destination || '',
      travel_date: date || job.travel_date || '',
      departure_time: time || job.departure_time || '',
      booking_status: job.booking_status || data?.bookingDetails?.bookingStatus || '',
      lift_status: liftStatus,
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
  workbook.creator  = 'IndiGo PNR Scraper';
  workbook.created  = new Date();

  // ── Sheet 1: Successful results ──────────────────────────────────────────
  const ws1 = workbook.addWorksheet('Results', {
    views: [{ state: 'frozen', ySplit: 1 }]
  });

  ws1.columns = [
    { header: 'PNR',                     key: 'pnr',                      width: 14 },
    { header: 'Last Name',               key: 'last_name',                width: 18 },
    { header: 'Origin',                  key: 'origin',                   width: 12 },
    { header: 'Destination',             key: 'destination',              width: 12 },
    { header: 'Travel Date',             key: 'travel_date',              width: 14 },
    { header: 'Travel Time',             key: 'departure_time',           width: 14 },
    { header: 'Booking Status',          key: 'booking_status',           width: 16 },
    { header: 'Lift Status',             key: 'lift_status',              width: 18 },
  ];

  // Style header row
  const headerRow = ws1.getRow(1);
  headerRow.font      = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'center' };
  headerRow.height    = 22;

  // Add data rows
  let resultRowCount = 0;
  for (const job of doneJobs) {
    const passengerRows = buildPassengerRows(job);
    for (const item of passengerRows) {
      const row = ws1.addRow(item);
      resultRowCount += 1;

      // Color-code booking status
      const statusCell = row.getCell('booking_status');
      if (String(item.booking_status || '').toUpperCase() === 'CONFIRMED') {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } };
        statusCell.font = { color: { argb: 'FF155724' } };
      } else if (String(item.booking_status || '').toUpperCase() === 'CANCELLED') {
        statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7DA' } };
        statusCell.font = { color: { argb: 'FF721C24' } };
      }

      // Alternate row background
      if (row.number % 2 === 0) {
        row.eachCell({ includeEmpty: true }, (cell) => {
          if (!cell.fill || cell.fill.fgColor?.argb === 'FFFFFFFF') {
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8F9FA' } };
          }
        });
      }
    }
  }

  // Auto-filter on header
  ws1.autoFilter = { from: 'A1', to: 'H1' };

  // ── Sheet 2: Failed records ───────────────────────────────────────────────
  const ws2 = workbook.addWorksheet('Failed Records');
  ws2.columns = [
    { header: 'PNR',         key: 'pnr',        width: 14 },
    { header: 'Last Name',   key: 'last_name',  width: 18 },
    { header: 'Error',       key: 'error_msg',  width: 50 },
    { header: 'Retry Count', key: 'retry_count',width: 14 },
    { header: 'Last Tried',  key: 'last_attempted_at', width: 20 },
  ];

  const hdr2 = ws2.getRow(1);
  hdr2.font  = { bold: true, color: { argb: 'FFFFFFFF' } };
  hdr2.fill  = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF8B0000' } };
  hdr2.height = 22;

  for (const job of failJobs) {
    ws2.addRow({
      pnr:               job.pnr,
      last_name:         job.last_name,
      error_msg:         job.error_msg    || '',
      retry_count:       job.retry_count  || 0,
      last_attempted_at: job.last_attempted_at || '',
    });
  }

  // ── Sheet 3: Summary ─────────────────────────────────────────────────────
  const ws3 = workbook.addWorksheet('Summary');
  ws3.getColumn(1).width = 24;
  ws3.getColumn(2).width = 16;

  const summaryData = [
    ['Generated At',    new Date().toLocaleString('en-IN')],
    ['Total Records',   stats.total],
    ['Completed',       stats.done],
    ['Failed',          stats.failed],
    ['Pending/Retry',   stats.pending + stats.retry],
    ['Success Rate',    stats.total > 0 ? ((stats.done / stats.total) * 100).toFixed(1) + '%' : '0%'],
  ];

  for (const [label, value] of summaryData) {
    const row = ws3.addRow([label, value]);
    row.getCell(1).font = { bold: true };
  }

  // ── Write file ────────────────────────────────────────────────────────────
  await workbook.xlsx.writeFile(outPath);

  console.log(`✅ Excel exported to: ${outPath}`);
  console.log(`   Results sheet : ${resultRowCount} rows`);
  console.log(`   Failed sheet  : ${failJobs.length} rows\n`);
}

exportExcel().catch(err => {
  logger.error('Export failed:', err);
  process.exit(1);
});
