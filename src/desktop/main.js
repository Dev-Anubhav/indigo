'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const { app, BrowserWindow, dialog } = require('electron');

const APP_ROOT = path.resolve(__dirname, '..', '..');
const HOST = process.env.WEB_HOST || '127.0.0.1';
const PORT = parseInt(process.env.WEB_PORT || '8787', 10);
const BASE_URL = `http://${HOST}:${PORT}`;

let serverProc = null;
let workRoot = '';
let browsersPath = '';
let publicDir = '';

function waitForHealth(url, timeoutMs = 30000) {
  const start = Date.now();

  return new Promise((resolve, reject) => {
    function check() {
      const req = http.get(`${url}/api/health`, res => {
        res.resume();
        if (res.statusCode === 200) {
          resolve();
          return;
        }
        retry();
      });

      req.on('error', retry);

      function retry() {
        if (Date.now() - start > timeoutMs) {
          reject(new Error('Web server did not become ready in time.'));
          return;
        }
        setTimeout(check, 400);
      }
    }

    check();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    const serverScript = path.join(APP_ROOT, 'src', 'web', 'server.js');
    workRoot = path.join(app.getPath('userData'), 'workspace');
    browsersPath = path.join(workRoot, 'ms-playwright');
    const workspacePublicDir = path.join(workRoot, 'public');
    const packagedPublicDir = path.join(APP_ROOT, 'public');
    fs.mkdirSync(workRoot, { recursive: true });
    fs.mkdirSync(browsersPath, { recursive: true });
    fs.mkdirSync(workspacePublicDir, { recursive: true });
    publicDir = fs.existsSync(packagedPublicDir) ? packagedPublicDir : workspacePublicDir;

    serverProc = spawn(process.execPath, [serverScript], {
      cwd: workRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        NODE_BINARY: process.execPath,
        APP_ROOT,
        WORK_ROOT: workRoot,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
        PUBLIC_DIR: publicDir,
        AUTO_OPEN_BROWSER: 'false',
        WEB_HOST: HOST,
        WEB_PORT: String(PORT),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProc.stdout.on('data', chunk => {
      process.stdout.write(`[server] ${String(chunk)}`);
    });

    serverProc.stderr.on('data', chunk => {
      process.stderr.write(`[server-err] ${String(chunk)}`);
    });

    serverProc.on('error', reject);

    serverProc.on('exit', code => {
      if (code !== 0) {
        console.error(`Server exited with code ${code}`);
      }
    });

    waitForHealth(BASE_URL).then(resolve).catch(reject);
  });
}

function ensurePlaywrightBrowser() {
  return new Promise((resolve, reject) => {
    const cliScript = path.join(APP_ROOT, 'node_modules', 'playwright', 'cli.js');
    if (!fs.existsSync(cliScript)) {
      reject(new Error('Playwright CLI not found in app package.'));
      return;
    }

    const proc = spawn(process.execPath, [cliScript, 'install', 'chromium'], {
      cwd: workRoot,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', chunk => process.stdout.write(`[playwright] ${String(chunk)}`));
    proc.stderr.on('data', chunk => process.stderr.write(`[playwright-err] ${String(chunk)}`));
    proc.on('error', reject);
    proc.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`Playwright browser install failed with code ${code}`));
    });
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1024,
    minHeight: 720,
    title: 'Airline Data Extractor',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.webContents.on('did-fail-load', async (_event, code, description, validatedURL) => {
    const safeDescription = String(description || 'Unknown load error');
    const safeUrl = String(validatedURL || BASE_URL);
    const html = `
      <html>
        <body style="font-family:-apple-system,Segoe UI,sans-serif;background:#f7f9fc;padding:28px;color:#10243e;">
          <h2>Unable To Load App UI</h2>
          <p><strong>URL:</strong> ${safeUrl}</p>
          <p><strong>Error:</strong> ${safeDescription} (${code})</p>
          <p>Please close and reopen the app once. If it persists, rebuild and reinstall latest DMG.</p>
        </body>
      </html>
    `;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });

  win.loadURL(BASE_URL);
}

function shutdownServer() {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM');
  }
}

app.on('window-all-closed', () => {
  shutdownServer();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  shutdownServer();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.whenReady()
  .then(async () => {
    try {
      workRoot = path.join(app.getPath('userData'), 'workspace');
      browsersPath = path.join(workRoot, 'ms-playwright');
      fs.mkdirSync(workRoot, { recursive: true });
      fs.mkdirSync(browsersPath, { recursive: true });

      await ensurePlaywrightBrowser();
      await startServer();
      createWindow();
    } catch (err) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'Startup Error',
        message: 'Could not start Airline Data Extractor.',
        detail: err.message,
      });
      shutdownServer();
      app.quit();
    }
  })
  .catch(err => {
    console.error(err);
    shutdownServer();
    app.quit();
  });
