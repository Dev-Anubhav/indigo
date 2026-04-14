'use strict';

require('dotenv').config();
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const db = require('./db');
const logger = require('./logger');

const OUTPUT_PATH = process.env.REFUND_OUTPUT_EXCEL || './output/refund_results.xlsx';

async function exportRefundExcel() {
  const outPath = path.resolve(OUTPUT_PATH);
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const doneJobs = db.getAllDone();
  const failJobs = db.getAllFailed();

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'IndiGo Refund Processor';
  workbook.created = new Date();

  const ws1 = workbook.addWorksheet('Refund Results', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  ws1.columns = [
    { header: 'PNR', key: 'pnr', width: 14 },
    { header: 'Last Name', key: 'last_name', width: 18 },
    { header: 'Refund Amount', key: 'refund_amount', width: 16 },
    { header: 'Refund Status', key: 'refund_status', width: 18 },
  ];

  const headerRow = ws1.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A5F' } };

  const refundRows = doneJobs.map(job => ({
    pnr: job.pnr,
    last_name: job.last_name,
    refund_amount: job.refund_amount || '',
    refund_status: job.refund_status || '',
  }));

  refundRows.forEach(row => ws1.addRow(row));
  ws1.autoFilter = { from: 'A1', to: 'D1' };

  const ws2 = workbook.addWorksheet('Failed Records');
  ws2.columns = [
    { header: 'PNR', key: 'pnr', width: 14 },
    { header: 'Last Name', key: 'last_name', width: 18 },
    { header: 'Error', key: 'error_msg', width: 60 },
  ];
  failJobs.forEach(job => {
    ws2.addRow({
      pnr: job.pnr,
      last_name: job.last_name,
      error_msg: job.error_msg || '',
    });
  });

  await workbook.xlsx.writeFile(outPath);
  console.log(`✅ Refund Excel exported to: ${outPath}`);
  console.log(`   Refund rows : ${refundRows.length}`);
  console.log(`   Failed rows : ${failJobs.length}`);
}

exportRefundExcel().catch(err => {
  logger.error('Refund export failed:', err);
  process.exit(1);
});
