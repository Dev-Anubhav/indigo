'use strict';

require('dotenv').config();
const ExcelJS = require('exceljs');
const path    = require('path');
const db      = require('./db');
const logger  = require('./logger');

const INPUT_PATH = process.env.INPUT_EXCEL || './data/input.xlsx';

async function importExcel() {
  const filePath = path.resolve(INPUT_PATH);
  console.log(`\n📂 Reading: ${filePath}\n`);

  const workbook  = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const worksheet = workbook.worksheets[0];
  const rows = [];

  // Auto-detect column positions by header name
  let pnrCol = -1;
  let lastNameCol = -1;
  let emailCol = -1;
  let mobileCol = -1;
  let contactCol = -1;

  const headerRow = worksheet.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    const val = String(cell.value || '').toLowerCase().trim();
    if (val.includes('pnr') || val.includes('booking') || val.includes('reference')) {
      pnrCol = colNumber;
    }
    if (val.includes('last') || val.includes('surname') || val.includes('name')) {
      lastNameCol = colNumber;
    }
    if (val.includes('email')) {
      emailCol = colNumber;
    }
    if (val.includes('mobile') || val.includes('phone')) {
      mobileCol = colNumber;
    }
    if (val.includes('contact')) {
      contactCol = colNumber;
    }
  });

  const detailCol = lastNameCol > 0
    ? lastNameCol
    : emailCol > 0
      ? emailCol
      : mobileCol > 0
        ? mobileCol
        : contactCol;

  console.log(`  Detected PNR column      : ${pnrCol}`);
  console.log(`  Detected Last Name column: ${lastNameCol}`);
  console.log(`  Detected Email column    : ${emailCol}`);
  console.log(`  Detected Mobile column   : ${mobileCol}`);
  console.log(`  Using Detail column      : ${detailCol}\n`);

  if (pnrCol < 0 || detailCol < 0) {
    console.error('❌ Required columns not found. Need PNR plus one of: Last Name, Email, Mobile, Contact.');
    process.exit(1);
  }

  // Read all rows (skip header row 1)
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header

    const pnr = String(row.getCell(pnrCol).value || '').trim().toUpperCase();
    const contactDetail = String(row.getCell(detailCol).value || '').trim().toUpperCase();

    if (!pnr || !contactDetail) return; // skip empty rows
    if (pnr.length < 4)    return; // skip obviously invalid PNRs

    rows.push({ pnr, last_name: contactDetail });
  });

  if (rows.length === 0) {
    console.error('❌ No valid rows found. Check your Excel file has PNR and one supported detail column.');
    process.exit(1);
  }

  // Insert into DB (INSERT OR IGNORE — safe to re-run, won't duplicate)
  db.insertJobs(rows);

  const stats = db.getStats();
  console.log(`✅ Imported ${rows.length} rows from Excel`);
  console.log(`📊 Queue status:`);
  console.log(`   Pending  : ${stats.pending}`);
  console.log(`   Done     : ${stats.done}`);
  console.log(`   Failed   : ${stats.failed}`);
  console.log(`   Total    : ${stats.total}`);
  console.log(`\n▶️  Run "npm start" to begin processing.\n`);
}

importExcel().catch(err => {
  logger.error('Import failed:', err);
  process.exit(1);
});
