'use strict';

require('dotenv').config();

const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { exec } = require('child_process');
const db = require('../db');

const PORT = parseInt(process.env.WEB_PORT || 8787, 10);
const HOST = process.env.WEB_HOST || '127.0.0.1';
const AUTO_OPEN_BROWSER = process.env.AUTO_OPEN_BROWSER === 'true';
const APP_ROOT = path.resolve(process.env.APP_ROOT || process.cwd());
const WORK_ROOT = path.resolve(process.env.WORK_ROOT || process.cwd());
const NODE_BINARY = process.env.NODE_BINARY || 'node';
const PUBLIC_DIR = path.resolve(process.env.PUBLIC_DIR || path.join(APP_ROOT, 'public'));
const UPLOAD_DIR = path.resolve(WORK_ROOT, 'data/uploads');
const RESULTS_XLSX = path.resolve(process.env.OUTPUT_EXCEL || path.join(WORK_ROOT, 'output/results.xlsx'));
const STATUS_XLSX = path.resolve(process.env.STATUS_OUTPUT_XLSX || path.join(WORK_ROOT, 'output/status_live.xlsx'));

let activeRun = null;
const logBuffer = [];
const LOG_LIMIT = 600;

function pushLog(line) {
  const ts = new Date().toISOString();
  logBuffer.push(`[${ts}] ${line}`);
  if (logBuffer.length > LOG_LIMIT) logBuffer.shift();
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 25 * 1024 * 1024) {
        reject(new Error('Request too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sanitizeName(name) {
  return String(name || 'input.xlsx').replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function importUploadedExcel(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE_BINARY, [path.join(APP_ROOT, 'src', 'import.js')], {
      cwd: WORK_ROOT,
      env: {
        ...process.env,
        APP_ROOT,
        WORK_ROOT,
        INPUT_EXCEL: filePath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    proc.stdout.on('data', d => { out += String(d); });
    proc.stderr.on('data', d => { err += String(d); });

    proc.on('close', code => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(`Import failed (${code}): ${err || out}`));
    });
  });
}

async function exportResultsExcel() {
  return new Promise((resolve, reject) => {
    const proc = spawn(NODE_BINARY, [path.join(APP_ROOT, 'src', 'export.js')], {
      cwd: WORK_ROOT,
      env: {
        ...process.env,
        APP_ROOT,
        WORK_ROOT,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    let err = '';
    proc.stdout.on('data', d => { out += String(d); });
    proc.stderr.on('data', d => { err += String(d); });

    proc.on('close', code => {
      if (code === 0) return resolve({ out, err });
      reject(new Error(`Export failed (${code}): ${err || out}`));
    });
  });
}

function resetWorkspaceForNewUpload() {
  const database = db.getDb();
  database.exec(`
    DELETE FROM jobs;
    DELETE FROM run_log;
  `);

  try { if (fs.existsSync(RESULTS_XLSX)) fs.unlinkSync(RESULTS_XLSX); } catch (_) {}
  try { if (fs.existsSync(STATUS_XLSX)) fs.unlinkSync(STATUS_XLSX); } catch (_) {}
}

function startRun(airline) {
  if (activeRun && !activeRun.proc.killed) {
    throw new Error('Run already in progress');
  }
  if (airline !== 'indigo') {
    throw new Error('Only indigo is currently implemented');
  }

  const proc = spawn(NODE_BINARY, [path.join(APP_ROOT, 'src', 'index.js')], {
    cwd: WORK_ROOT,
    env: {
      ...process.env,
      APP_ROOT,
      WORK_ROOT,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  activeRun = {
    airline,
    proc,
    startedAt: new Date().toISOString(),
    exitCode: null,
    finishedAt: null,
  };

  proc.stdout.on('data', d => {
    const text = String(d).trim();
    if (text) pushLog(text);
  });
  proc.stderr.on('data', d => {
    const text = String(d).trim();
    if (text) pushLog(`ERR ${text}`);
  });

  proc.on('close', code => {
    if (activeRun && activeRun.proc === proc) {
      activeRun.exitCode = code;
      activeRun.finishedAt = new Date().toISOString();
      pushLog(`Run finished with code ${code}`);
      if (code === 0) {
        exportResultsExcel()
          .then(() => pushLog('Final results exported'))
          .catch(err => pushLog(`ERR Final export failed: ${err.message}`));
      }
      setTimeout(() => {
        if (activeRun && activeRun.proc === proc) activeRun = null;
      }, 120000);
    }
  });

  pushLog(`Run started for airline=${airline}`);
}

function stopRun() {
  if (!activeRun || !activeRun.proc || activeRun.proc.killed) return false;
  activeRun.proc.kill('SIGTERM');
  pushLog('Stop requested by user');
  return true;
}

function sendFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    json(res, 404, { ok: false, error: 'File not found' });
    return;
  }
  const stream = fs.createReadStream(filePath);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${path.basename(filePath)}"`,
  });
  stream.pipe(res);
}

function serveStatic(req, res) {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const full = path.resolve(PUBLIC_DIR, `.${reqPath}`);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext = path.extname(full).toLowerCase();
  const ct = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': ct });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const { method, url } = req;

    if (method === 'GET' && url.startsWith('/api/health')) {
      return json(res, 200, { ok: true, now: new Date().toISOString() });
    }

    if (method === 'GET' && url.startsWith('/api/status')) {
      const stats = db.getStats();
      return json(res, 200, {
        ok: true,
        stats,
        run: activeRun ? {
          airline: activeRun.airline,
          startedAt: activeRun.startedAt,
          exitCode: activeRun.exitCode,
          finishedAt: activeRun.finishedAt,
          running: !!(activeRun.proc && !activeRun.proc.killed && activeRun.exitCode == null),
        } : { running: false },
        files: {
          results: fs.existsSync(RESULTS_XLSX),
          statusLive: fs.existsSync(STATUS_XLSX),
        },
      });
    }

    if (method === 'GET' && url.startsWith('/api/logs')) {
      return json(res, 200, { ok: true, logs: logBuffer.slice(-200) });
    }

    if (method === 'GET' && url.startsWith('/api/download/results')) {
      if (!fs.existsSync(RESULTS_XLSX)) {
        await exportResultsExcel();
      }
      return sendFile(res, RESULTS_XLSX);
    }

    if (method === 'GET' && url.startsWith('/api/download/status-live')) {
      return sendFile(res, STATUS_XLSX);
    }

    if (method === 'POST' && url.startsWith('/api/upload')) {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      const airline = String(body.airline || 'indigo').toLowerCase();
      if (airline !== 'indigo') return json(res, 400, { ok: false, error: 'Only indigo is supported now' });

      const b64 = String(body.contentBase64 || '');
      if (!b64) return json(res, 400, { ok: false, error: 'Missing file data' });
      const replaceExisting = body.replaceExisting !== false;

      if (replaceExisting) {
        resetWorkspaceForNewUpload();
        pushLog('Workspace reset for new upload (jobs + output files)');
      }

      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      const stamp = Date.now();
      const filename = `${stamp}_${sanitizeName(body.filename || 'input.xlsx')}`;
      const filePath = path.resolve(UPLOAD_DIR, filename);

      fs.writeFileSync(filePath, Buffer.from(b64, 'base64'));
      pushLog(`Uploaded file saved: ${filePath}`);

      await importUploadedExcel(filePath);
      const stats = db.getStats();
      return json(res, 200, { ok: true, filePath, stats });
    }

    if (method === 'POST' && url.startsWith('/api/run/start')) {
      const raw = await readBody(req);
      const body = JSON.parse(raw || '{}');
      startRun(String(body.airline || 'indigo').toLowerCase());
      return json(res, 200, { ok: true });
    }

    if (method === 'POST' && url.startsWith('/api/run/stop')) {
      const stopped = stopRun();
      return json(res, 200, { ok: true, stopped });
    }

    if (method === 'POST' && url.startsWith('/api/jobs/reset-all')) {
      db.getDb().prepare(`
        UPDATE jobs SET status='pending', retry_count=0, error_msg=NULL, completed_at=NULL, last_attempted_at=NULL
        WHERE status IN ('done','failed','retry','processing')
      `).run();
      return json(res, 200, { ok: true, stats: db.getStats() });
    }

    return serveStatic(req, res);
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  console.log(`Web UI running at ${url}`);

  if (!AUTO_OPEN_BROWSER) return;

  const cmd =
    process.platform === 'darwin' ? `open "${url}"` :
    process.platform === 'win32' ? `start "" "${url}"` :
    `xdg-open "${url}"`;

  exec(cmd, () => {});
});
