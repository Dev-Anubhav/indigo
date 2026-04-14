'use strict';

require('dotenv').config();
const cliProgress = require('cli-progress');
const chalk = require('chalk');
const db = require('./db');
const logger = require('./logger');
const { fetchRefund, closeBrowser } = require('./airlines/indigo/refundScraper');

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || 40, 10);
let stopRequested = false;

function createProgressBar(total) {
  const bar = new cliProgress.SingleBar({
    format: chalk.cyan('{bar}') + ' {percentage}% | {value}/{total} | ✅ {done} ❌ {failed} ⏳ {eta_formatted}',
    barCompleteChar: '█',
    barIncompleteChar: '░',
    hideCursor: true,
  }, cliProgress.Presets.shades_classic);
  bar.start(total, 0, { done: 0, failed: 0 });
  return bar;
}

async function processJob(job) {
  db.markProcessing(job.id);
  let result;
  try {
    result = await fetchRefund(job.pnr, job.last_name);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err || '');
    if (msg.toLowerCase().includes('target page, context or browser has been closed')) {
      return { stopped: true };
    }
    result = { success: false, error: msg || 'Refund flow failed' };
  }

  if (result && result.stopped) return { stopped: true };

  if (result.success) {
    db.markRefundDone(job.id, result.data);
    logger.info(`  ✅ [${job.pnr}] Refund ${result.data.refund_amount || 'NA'} | ${result.data.refund_status}`);
    return { success: true };
  }

  db.markFailed(job.id, result.error, false);
  logger.warn(`  ❌ [${job.pnr}] Failed — ${result.error}`);
  return { success: false };
}

async function run() {
  const stats = db.getStats();
  const total = stats.pending + stats.retry + stats.done;

  console.log('\n' + chalk.bold.blue('═══════════════════════════════════════════════════'));
  console.log(chalk.bold.blue('   IndiGo Refund Processor'));
  console.log(chalk.bold.blue('═══════════════════════════════════════════════════'));
  console.log(chalk.white(`  Total jobs   : ${chalk.yellow(total)}`));
  console.log(chalk.white(`  Pending      : ${chalk.yellow(stats.pending + stats.retry)}`));
  console.log(chalk.white(`  Done         : ${chalk.green(stats.done)}`));
  console.log(chalk.white(`  Failed       : ${chalk.red(stats.failed)}`));
  console.log(chalk.bold.blue('═══════════════════════════════════════════════════\n'));

  const bar = createProgressBar(total);
  let processed = stats.done;
  bar.update(processed, { done: stats.done, failed: stats.failed });

  while (true) {
    const batch = db.getNextBatch(BATCH_SIZE);
    if (batch.length === 0) break;

    logger.info(`\n📦 Refund Batch — ${batch.length} jobs`);
    for (const job of batch) {
      if (stopRequested) break;
      const outcome = await processJob(job);
      if (outcome && outcome.stopped) {
        stopRequested = true;
        break;
      }
      processed += 1;
      const s = db.getStats();
      bar.update(processed, { done: s.done, failed: s.failed });
    }
    if (stopRequested) break;
  }

  bar.stop();
  await closeBrowser();

  const finalStats = db.getStats();
  console.log('\n' + chalk.bold.blue('═══════════════════════════════════════════════════'));
  console.log(chalk.bold.blue('   Refund Summary'));
  console.log(chalk.bold.blue('═══════════════════════════════════════════════════'));
  console.log(`  ✅ Done    : ${chalk.green(finalStats.done)}`);
  console.log(`  ❌ Failed  : ${chalk.red(finalStats.failed)}`);
  console.log(`  📊 Total   : ${chalk.yellow(finalStats.total)}`);
  console.log(chalk.bold.blue('═══════════════════════════════════════════════════'));
  console.log(chalk.cyan('\n  Run "npm run refund:export" to generate refund Excel.\n'));
}

run().catch(async (err) => {
  logger.error('Fatal error in refund run loop:', err);
  await closeBrowser();
  process.exit(1);
});

process.on('SIGTERM', async () => {
  stopRequested = true;
  await closeBrowser();
  process.exit(0);
});
