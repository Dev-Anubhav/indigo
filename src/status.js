'use strict';

require('dotenv').config();
const db    = require('./db');
const chalk = require('chalk');
const { getCurrentIP } = require('./rotator');

async function showStatus() {
  const stats = db.getStats();
  const ip    = await getCurrentIP();
  const done  = stats.done;
  const total = stats.total;
  const pct   = total > 0 ? ((done / total) * 100).toFixed(1) : 0;

  // Build a simple ASCII progress bar
  const barLen   = 40;
  const filled   = Math.round((done / Math.max(total, 1)) * barLen);
  const bar      = '█'.repeat(filled) + '░'.repeat(barLen - filled);

  console.log('\n' + chalk.bold.blue('═══════════════════════════════════════════════'));
  console.log(chalk.bold.blue('   IndiGo Scraper — Live Status'));
  console.log(chalk.bold.blue('═══════════════════════════════════════════════'));
  console.log(`  Current IP  : ${chalk.yellow(ip || 'unknown')}`);
  console.log(`  Progress    : [${chalk.cyan(bar)}] ${chalk.yellow(pct + '%')}`);
  console.log(`  ✅ Done     : ${chalk.green(stats.done)}`);
  console.log(`  ⏳ Pending  : ${chalk.yellow(stats.pending)}`);
  console.log(`  🔁 Retry    : ${chalk.yellow(stats.retry)}`);
  console.log(`  ❌ Failed   : ${chalk.red(stats.failed)}`);
  console.log(`  📊 Total    : ${chalk.white(stats.total)}`);

  // Estimate time remaining
  if (stats.pending + stats.retry > 0) {
    const avgSecsPerRecord = 16; // avg of min+max delay + page load
    const remaining        = (stats.pending + stats.retry) * avgSecsPerRecord;
    const hours            = Math.floor(remaining / 3600);
    const minutes          = Math.floor((remaining % 3600) / 60);
    console.log(`  ⏰ Est. remaining: ${chalk.yellow(hours + 'h ' + minutes + 'm')} (approx)`);
  }

  console.log(chalk.bold.blue('═══════════════════════════════════════════════\n'));
}

showStatus().catch(console.error);
