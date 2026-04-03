'use strict';

const path = require('path');
const { Worker } = require('worker_threads');

let worker = null;

async function initStatusWriter() {
  if (worker) return;
  worker = new Worker(path.resolve(__dirname, 'statusWriterWorker.js'));
}

function enqueueStatusRow(row) {
  if (!worker) return;
  worker.postMessage({ type: 'record', row });
}

async function shutdownStatusWriter() {
  if (!worker) return;
  const current = worker;
  worker = null;

  await new Promise(resolve => {
    const done = () => resolve();
    current.on('exit', done);
    current.on('error', done);
    current.postMessage({ type: 'shutdown' });
    setTimeout(done, 5000);
  });
}

module.exports = {
  initStatusWriter,
  enqueueStatusRow,
  shutdownStatusWriter,
};
