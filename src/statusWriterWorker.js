'use strict';

const { parentPort } = require('worker_threads');
const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = process.env.STATUS_OUTPUT_XLSX || './output/status_live.xlsx';
const TARGET_STATUSES = new Set([
  'CANCELLED',
  'FLOWN',
  'NOSHOW',
  'ALREADYREFUNDED',
  'HOLDCANCELLED',
]);

const workbook = new ExcelJS.Workbook();
let worksheet = null;
let initialized = false;
let flushInProgress = false;
let flushTimer = null;
const queue = [];

function normalizeStatus(status) {
  return String(status || '')
    .replace(/[\s-]/g, '')
    .toUpperCase();
}

async function initWorkbook() {
  if (initialized) return;
  const outPath = path.resolve(OUTPUT_PATH);
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  if (fs.existsSync(outPath)) {
    await workbook.xlsx.readFile(outPath);
  }

  worksheet = workbook.getWorksheet('Status Tracking');
  if (!worksheet) {
    worksheet = workbook.addWorksheet('Status Tracking');
    worksheet.columns = [
      { header: 'PNR', key: 'pnr', width: 14 },
      { header: 'Last Name', key: 'last_name', width: 20 },
      { header: 'Booking Status', key: 'booking_status', width: 22 },
      { header: 'Travel Status', key: 'travel_status', width: 18 },
      { header: 'Lift Status', key: 'lift_status', width: 16 },
      { header: 'Tracked Status', key: 'tracked_status', width: 16 },
      { header: 'Flight Number', key: 'flight_number', width: 16 },
      { header: 'Travel Date', key: 'travel_date', width: 14 },
      { header: 'Completed At', key: 'completed_at', width: 22 },
      { header: 'Error', key: 'error', width: 40 },
    ];
    const header = worksheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };
  } else {
    const desired = [
      { header: 'PNR', key: 'pnr', width: 14 },
      { header: 'Last Name', key: 'last_name', width: 20 },
      { header: 'Booking Status', key: 'booking_status', width: 22 },
      { header: 'Travel Status', key: 'travel_status', width: 18 },
      { header: 'Lift Status', key: 'lift_status', width: 16 },
      { header: 'Tracked Status', key: 'tracked_status', width: 16 },
      { header: 'Flight Number', key: 'flight_number', width: 16 },
      { header: 'Travel Date', key: 'travel_date', width: 14 },
      { header: 'Completed At', key: 'completed_at', width: 22 },
      { header: 'Error', key: 'error', width: 40 },
    ];

    worksheet.columns = desired;
    const header = worksheet.getRow(1);
    if (!header.getCell(1).value) {
      desired.forEach((c, i) => { header.getCell(i + 1).value = c.header; });
    }
  }

  initialized = true;
}

async function flush() {
  if (flushInProgress || queue.length === 0) return;
  flushInProgress = true;

  try {
    await initWorkbook();
    while (queue.length) {
      const row = queue.shift();
      worksheet.addRow(row);
    }
    await workbook.xlsx.writeFile(path.resolve(OUTPUT_PATH));
  } finally {
    flushInProgress = false;
  }
}

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flush();
  }, 700);
}

parentPort.on('message', async msg => {
  if (!msg || !msg.type) return;

  if (msg.type === 'record') {
    const bookingNorm = normalizeStatus(msg.row.booking_status);
    const liftNorm = normalizeStatus(msg.row.lift_status);
    queue.push({
      ...msg.row,
      tracked_status: (TARGET_STATUSES.has(bookingNorm) || TARGET_STATUSES.has(liftNorm)) ? 'YES' : 'NO',
    });
    scheduleFlush();
    return;
  }

  if (msg.type === 'flush') {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flush();
    parentPort.postMessage({ type: 'flushed' });
    return;
  }

  if (msg.type === 'shutdown') {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    await flush();
    parentPort.postMessage({ type: 'shutdown-complete' });
    process.exit(0);
  }
});
