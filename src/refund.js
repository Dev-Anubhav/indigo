"use strict";

require("dotenv").config();
const cliProgress = require("cli-progress");
const chalk = require("chalk");
const db = require("./db");
const logger = require("./logger");
const {
  fetchRefund,
  closeBrowser,
} = require("./airlines/indigo/refundScraper");

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || 40, 10);
let stopRequested = false;

function createProgressBar(total) {
  const bar = new cliProgress.SingleBar(
    {
      format:
        chalk.cyan("{bar}") +
        " {percentage}% | {value}/{total} | ✅ {done} ❌ {failed} ⏳ {eta_formatted}",
      barCompleteChar: "█",
      barIncompleteChar: "░",
      hideCursor: true,
    },
    cliProgress.Presets.shades_classic
  );
  bar.start(total, 0, { done: 0, failed: 0 });
  return bar;
}

/**
 * Handle a result coming back from the Python scraper.
 * Looks up the job by id, updates DB, logs outcome.
 */
function handleResult(result, job, bar, processedRef) {
  if (result.success && (result.apiStatus === 200 || result.refundAmount)) {
    db.markRefundDone(job.id, {
      refund_amount: result.refundAmount ? String(result.refundAmount) : null,
      refund_status: result.toastMessage || null,
      raw_json: result.rawApiResponse
        ? JSON.stringify(result.rawApiResponse)
        : null,
    });
    logger.info(
      `  ✅ [${job.pnr}] Refund ${result.refundAmount || "NA"} | ${result.toastMessage}`
    );
  } else {
    const errorMsg =
      result.toastMessage ||
      result.error ||
      `API status ${result.apiStatus}` ||
      "No refund amount received";
    db.markFailed(job.id, errorMsg, false);
    logger.warn(`  ❌ [${job.pnr}] Failed — ${errorMsg}`);
  }

  processedRef.count += 1;
  const s = db.getStats();
  bar.update(processedRef.count, { done: s.done, failed: s.failed });
}

async function run() {
  const stats = db.getStats();
  const total = stats.pending + stats.retry + stats.done;

  console.log(
    "\n" + chalk.bold.blue("═══════════════════════════════════════════════════")
  );
  console.log(chalk.bold.blue("   IndiGo Refund Processor"));
  console.log(
    chalk.bold.blue("═══════════════════════════════════════════════════")
  );
  console.log(chalk.white(`  Total jobs   : ${chalk.yellow(total)}`));
  console.log(
    chalk.white(`  Pending      : ${chalk.yellow(stats.pending + stats.retry)}`)
  );
  console.log(chalk.white(`  Done         : ${chalk.green(stats.done)}`));
  console.log(chalk.white(`  Failed       : ${chalk.red(stats.failed)}`));
  console.log(
    chalk.bold.blue("═══════════════════════════════════════════════════\n")
  );

  const bar = createProgressBar(total);
  const processedRef = { count: stats.done };
  bar.update(processedRef.count, { done: stats.done, failed: stats.failed });

  while (true) {
    if (stopRequested) break;

    const batch = db.getNextBatch(BATCH_SIZE);
    if (batch.length === 0) break;

    logger.info(`\n📦 Refund Batch — ${batch.length} jobs`);

    for (const job of batch) {
      if (stopRequested) break;

      db.markProcessing(job.id);

      try {
        const result = await fetchRefund(job.pnr, job.last_name);
        handleResult(result, job, bar, processedRef);
      } catch (err) {
        const errorMsg = err.message || "Unknown error";
        db.markFailed(job.id, errorMsg, false);
        logger.warn(`  ❌ [${job.pnr}] Error — ${errorMsg}`);
        processedRef.count += 1;
        const s = db.getStats();
        bar.update(processedRef.count, { done: s.done, failed: s.failed });
      }
    }

    if (stopRequested) break;
  }

  bar.stop();
  await closeBrowser();

  const finalStats = db.getStats();
  console.log(
    "\n" + chalk.bold.blue("═══════════════════════════════════════════════════")
  );
  console.log(chalk.bold.blue("   Refund Summary"));
  console.log(
    chalk.bold.blue("═══════════════════════════════════════════════════")
  );
  console.log(`  ✅ Done    : ${chalk.green(finalStats.done)}`);
  console.log(`  ❌ Failed  : ${chalk.red(finalStats.failed)}`);
  console.log(`  📊 Total   : ${chalk.yellow(finalStats.total)}`);
  console.log(
    chalk.bold.blue("═══════════════════════════════════════════════════")
  );
  console.log(
    chalk.cyan('\n  Run "npm run refund:export" to generate refund Excel.\n')
  );
}

run().catch(async (err) => {
  logger.error("Fatal error in refund run loop:", err);
  await closeBrowser();
  process.exit(1);
});

process.on("SIGTERM", async () => {
  stopRequested = true;
  await closeBrowser();
  process.exit(0);
});
