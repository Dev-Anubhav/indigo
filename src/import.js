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
  let pnrCol      = 1;  // default: column A
  let lastNameCol = 2;  // default: column B

  const headerRow = worksheet.getRow(1);
  headerRow.eachCell((cell, colNumber) => {
    const val = String(cell.value || '').toLowerCase().trim();
    if (val.includes('pnr') || val.includes('booking') || val.includes('reference')) {
      pnrCol = colNumber;
    }
    if (val.includes('last') || val.includes('surname') || val.includes('name')) {
      lastNameCol = colNumber;
    }
  });

  console.log(`  Detected PNR column      : ${pnrCol}`);
  console.log(`  Detected Last Name column: ${lastNameCol}\n`);

  // Read all rows (skip header row 1)
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // skip header

    const pnr      = String(row.getCell(pnrCol).value      || '').trim().toUpperCase();
    const lastName = String(row.getCell(lastNameCol).value || '').trim().toUpperCase();

    if (!pnr || !lastName) return; // skip empty rows
    if (pnr.length < 4)    return; // skip obviously invalid PNRs

    rows.push({ pnr, last_name: lastName });
  });

  if (rows.length === 0) {
    console.error('❌ No valid rows found. Check your Excel file has PNR and Last Name columns.');
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
