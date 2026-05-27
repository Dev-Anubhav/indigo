'use strict';

require('dotenv').config();
const cliProgress = require('cli-progress');
const chalk        = require('chalk');
const db           = require('./db');
const logger       = require('./logger');
const { fetchPNR, closeBrowser } = require('./scraper');
const { initStatusWriter, enqueueStatusRow, shutdownStatusWriter } = require('./statusWriter');
const { rotateIP, waitForNetwork, sleep, getCurrentIP } = require('./rotator');

const SPEED_PROFILE = String(process.env.SPEED_PROFILE || 'normal').toLowerCase();
const FAST_MODE = SPEED_PROFILE === 'fast' || SPEED_PROFILE === 'turbo';

const BATCH_SIZE  = parseInt(process.env.BATCH_SIZE  || 40);
const MIN_DELAY   = parseInt(
  process.env.PER_PNR_DELAY_MIN_MS || process.env.MIN_DELAY_MS || (FAST_MODE ? 120 : 1200)
);
const MAX_DELAY   = parseInt(
  process.env.PER_PNR_DELAY_MAX_MS || process.env.MAX_DELAY_MS || (FAST_MODE ? 320 : 4500)
);

const AUTO_PAUSE_EVERY_N = parseInt(process.env.AUTO_PAUSE_EVERY_N || (FAST_MODE ? 0 : 25));
const AUTO_PAUSE_MIN_MS  = parseInt(process.env.AUTO_PAUSE_MIN_MS || 240000); // 4 min
const AUTO_PAUSE_MAX_MS  = parseInt(process.env.AUTO_PAUSE_MAX_MS || 420000); // 7 min

const HEALTH_WINDOW_SIZE = parseInt(process.env.HEALTH_WINDOW_SIZE || (FAST_MODE ? 30 : 20));
const HEALTH_FAIL_RATE_THRESHOLD = parseFloat(process.env.HEALTH_FAIL_RATE_THRESHOLD || (FAST_MODE ? 0.8 : 0.35));
const HEALTH_BLOCK_THRESHOLD = parseInt(process.env.HEALTH_BLOCK_THRESHOLD || (FAST_MODE ? 10 : 3));
const HEALTH_PAUSE_MIN_MS = parseInt(process.env.HEALTH_PAUSE_MIN_MS || 600000); // 10 min
const HEALTH_PAUSE_MAX_MS = parseInt(process.env.HEALTH_PAUSE_MAX_MS || 900000); // 15 min

// ─── Progress bar setup ──────────────────────────────────────────────────────

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

function randomBetween(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

function formatMs(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m ${sec}s`;
}

function isBlockLikeError(errorText) {
  const msg = String(errorText || '').toLowerCase();
  return (
    msg.includes('akamai failover') ||
    msg.includes('something went wrong') ||
    msg.includes('access denied') ||
    msg.includes('forbidden') ||
    msg.includes('captcha')
  );
}

// ─── Print startup banner ────────────────────────────────────────────────────

async function printBanner() {
  const stats = db.getStats();
  const ip    = await getCurrentIP();
  console.log('\n' + chalk.bold.blue('═══════════════════════════════════════════════════'));
  console.log(chalk.bold.blue('   IndiGo PNR Bulk Scraper'));
  console.log(chalk.bold.blue('═══════════════════════════════════════════════════'));
  console.log(chalk.white(`  Current IP   : ${chalk.yellow(ip || 'unknown')}`));
  console.log(chalk.white(`  Total jobs   : ${chalk.yellow(stats.total)}`));
  console.log(chalk.white(`  Pending      : ${chalk.yellow(stats.pending + stats.retry)}`));
  console.log(chalk.white(`  Done         : ${chalk.green(stats.done)}`));
  console.log(chalk.white(`  Failed       : ${chalk.red(stats.failed)}`));
  console.log(chalk.white(`  Batch size   : ${chalk.yellow(BATCH_SIZE)} (rotate IP every ${BATCH_SIZE} records)`));
  console.log(chalk.white(`  Speed mode   : ${chalk.yellow(SPEED_PROFILE)}`));
  console.log(chalk.white(`  Delay range  : ${chalk.yellow(MIN_DELAY / 1000)}s – ${chalk.yellow(MAX_DELAY / 1000)}s`));
  console.log(chalk.white(`  Cooldown     : every ${chalk.yellow(AUTO_PAUSE_EVERY_N)} records pause ${chalk.yellow(Math.floor(AUTO_PAUSE_MIN_MS / 60000))}-${chalk.yellow(Math.floor(AUTO_PAUSE_MAX_MS / 60000))} min`));
  console.log(chalk.white(`  Health pause : fail-rate>${chalk.yellow((HEALTH_FAIL_RATE_THRESHOLD * 100).toFixed(0))}% in ${chalk.yellow(HEALTH_WINDOW_SIZE)} or blocks>=${chalk.yellow(HEALTH_BLOCK_THRESHOLD)}`));
  console.log(chalk.bold.blue('═══════════════════════════════════════════════════\n'));
}

// ─── Process a single job ────────────────────────────────────────────────────

async function processJob(job) {
  db.markProcessing(job.id);

  const result = await fetchPNR(job.pnr, job.last_name);

  if (result.success) {
    db.markDone(job.id, result.data);
    enqueueStatusRow({
      pnr: job.pnr,
      last_name: job.last_name,
      booking_status: result.data.booking_status || '',
      lift_status: result.data.lift_status || '',
      flight_number: result.data.flight_number || '',
      travel_date: result.data.travel_date || '',
      completed_at: new Date().toISOString(),
      error: '',
    });
    logger.info(`  ✅ [${job.pnr}] Done — ${result.data.flight_number || 'no flight'} | ${result.data.booking_status || 'unknown status'}`);
    return { success: true, error: '' };
  } else {
    const isRetryable = !result.error.includes('not found') && !result.error.includes('invalid');
    db.markFailed(job.id, result.error, isRetryable);
    enqueueStatusRow({
      pnr: job.pnr,
      last_name: job.last_name,
      booking_status: '',
      lift_status: '',
      flight_number: '',
      travel_date: '',
      completed_at: new Date().toISOString(),
      error: result.error || '',
    });
    logger.warn(`  ❌ [${job.pnr}] Failed — ${result.error}`);
    return { success: false, error: result.error || '' };
  }
}

// ─── Main run loop ───────────────────────────────────────────────────────────

async function run() {
  await initStatusWriter();
  await printBanner();

  // Recover any jobs stuck from a previous crash
  const recovered = db.recoverStuckJobs();
  if (recovered > 0) logger.info(`♻️  Recovered ${recovered} stuck jobs from previous run`);

  const stats  = db.getStats();
  const total  = stats.pending + stats.retry + stats.done;
  const bar    = createProgressBar(total);
  let processed = 0;
  let batchNum  = 0;
  let processedSinceCooldown = 0;
  const recentOutcomes = [];

  // Update bar to reflect already-done jobs
  bar.update(stats.done, { done: stats.done, failed: stats.failed });
  processed = stats.done;

  while (true) {
    const batch = db.getNextBatch(BATCH_SIZE);
    if (batch.length === 0) {
      bar.stop();
      console.log('\n' + chalk.bold.green('🎉 All jobs processed!'));
      break;
    }

    batchNum++;
    logger.info(`\n📦 Batch #${batchNum} — ${batch.length} jobs`);

    let batchDone   = 0;
    let batchFailed = 0;

    for (let i = 0; i < batch.length; i++) {
      const job = batch[i];

      const outcome = await processJob(job);
      const success = outcome.success;
      if (success) batchDone++; else batchFailed++;
      processed++;
      processedSinceCooldown++;

      const currentStats = db.getStats();
      bar.update(processed, { done: currentStats.done, failed: currentStats.failed });

      const blockLike = !success && isBlockLikeError(outcome.error || '');
      recentOutcomes.push({ success, blockLike });
      if (recentOutcomes.length > HEALTH_WINDOW_SIZE) recentOutcomes.shift();

      if (recentOutcomes.length >= Math.min(HEALTH_WINDOW_SIZE, 10)) {
        const failures = recentOutcomes.filter(x => !x.success).length;
        const blocks = recentOutcomes.filter(x => x.blockLike).length;
        const failRate = failures / recentOutcomes.length;

        if (failRate >= HEALTH_FAIL_RATE_THRESHOLD || blocks >= HEALTH_BLOCK_THRESHOLD) {
          const pauseMs = randomBetween(HEALTH_PAUSE_MIN_MS, HEALTH_PAUSE_MAX_MS);
          logger.warn(`⏸️  Health pause triggered (failRate=${(failRate * 100).toFixed(0)}%, blocks=${blocks}/${recentOutcomes.length}). Waiting ${formatMs(pauseMs)}...`);
          await closeBrowser();
          await sleep(pauseMs);
          recentOutcomes.length = 0;
          processedSinceCooldown = 0;
        }
      }

      if (AUTO_PAUSE_EVERY_N > 0 && processedSinceCooldown >= AUTO_PAUSE_EVERY_N) {
        const pauseMs = randomBetween(AUTO_PAUSE_MIN_MS, AUTO_PAUSE_MAX_MS);
        logger.info(`⏸️  Scheduled cooldown after ${processedSinceCooldown} records. Waiting ${formatMs(pauseMs)}...`);
        await closeBrowser();
        await sleep(pauseMs);
        processedSinceCooldown = 0;
      }

      if (i < batch.length - 1 && MAX_DELAY > 0) {
        const delay = randomBetween(MIN_DELAY, MAX_DELAY);
        if (delay > 0) await sleep(delay);
      }
    }

    logger.info(`\n✅ Batch #${batchNum} complete — ${batchDone} succeeded, ${batchFailed} failed`);
    db.logEvent('batch_complete', JSON.stringify({ batchNum, batchDone, batchFailed }));

    // Check if more jobs remain before rotating
    const remaining = db.getNextBatch(1);
    if (remaining.length === 0) {
      bar.stop();
      console.log('\n' + chalk.bold.green('🎉 All jobs processed!'));
      break;
    }

    // ── IP Rotation ───────────────────────────────────────────────────────
    console.log('\n' + chalk.yellow('🔄 Rotating IP via router restart...'));
    logger.info('Starting IP rotation...');

    // Close browser before rotation (network will drop)
    await closeBrowser();

    const rotResult = await rotateIP();
    if (rotResult.changed) {
      console.log(chalk.green(`  ✅ IP changed: ${rotResult.oldIP} → ${rotResult.newIP}`));
    } else {
      console.log(chalk.yellow(`  ⚠️  IP may not have changed — continuing anyway`));
    }

    // Confirm network is fully back
    const networkOk = await waitForNetwork();
    if (!networkOk) {
      logger.error('Network did not recover after router restart. Continuing to next batch...');
    }
  }

  // Final summary
  const finalStats = db.getStats();
  await shutdownStatusWriter();
  await closeBrowser();

  console.log('\n' + chalk.bold.blue('═══════════════════════════════════════════════════'));
  console.log(chalk.bold.blue('   Final Summary'));
  console.log(chalk.bold.blue('═══════════════════════════════════════════════════'));
  console.log(`  ✅ Done    : ${chalk.green(finalStats.done)}`);
  console.log(`  ❌ Failed  : ${chalk.red(finalStats.failed)}`);
  console.log(`  📊 Total   : ${chalk.yellow(finalStats.total)}`);
  console.log(chalk.bold.blue('═══════════════════════════════════════════════════'));
  console.log(chalk.cyan('\n  Run "npm run export" to generate the Excel output file.\n'));

  db.logEvent('run_complete', JSON.stringify(finalStats));
}

run().catch(async (err) => {
  logger.error('Fatal error in main run loop:', err);
  await shutdownStatusWriter();
  await closeBrowser();
  process.exit(1);
});
