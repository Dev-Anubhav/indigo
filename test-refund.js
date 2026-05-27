'use strict';

/**
 * Quick one-off test for the refund scraper fix.
 * Usage:
 *   node test-refund.js <PNR> <LAST_NAME>
 *
 * Example:
 *   node test-refund.js ABC123 SHARMA
 *
 * To run headless (browser hidden):
 *   HEADLESS=true node test-refund.js ABC123 SHARMA
 */

require('dotenv').config();
const { fetchRefund, closeBrowser } = require('./src/airlines/indigo/refundScraper');

const pnr = process.argv[2];
const lastName = process.argv[3];

if (!pnr || !lastName) {
  console.error('\n❌  Usage: node test-refund.js <PNR> <LAST_NAME>\n');
  console.error('   Example: node test-refund.js ABC123 SHARMA\n');
  process.exit(1);
}

console.log(`\n🔍  Testing refund for PNR: ${pnr.toUpperCase()}  |  Last Name: ${lastName.toUpperCase()}`);
console.log('━'.repeat(60));

(async () => {
  try {
    const result = await fetchRefund(pnr.toUpperCase(), lastName.toUpperCase());

    console.log('\n📦  Raw result:');
    console.log(JSON.stringify(result, null, 2));

    if (result.success) {
      console.log('\n✅  SUCCESS');
      console.log(`   Refund Amount : ${result.data.refund_amount || 'N/A'}`);
      console.log(`   Refund Status : ${result.data.refund_status}`);
    } else {
      console.log('\n❌  FAILED');
      console.log(`   Error: ${result.error}`);
    }
  } catch (err) {
    console.error('\n💥  Unexpected error:', err.message);
  } finally {
    await closeBrowser();
    console.log('\n🔒  Browser closed. Done.\n');
  }
})();
