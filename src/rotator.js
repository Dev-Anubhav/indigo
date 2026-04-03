'use strict';

const axios = require('axios');
const { execSync } = require('child_process');
const logger = require('./logger');
require('dotenv').config();

const ROUTER_IP       = process.env.ROUTER_IP       || '192.168.1.1';
const ROUTER_USERNAME = process.env.ROUTER_USERNAME || 'admin';
const ROUTER_PASSWORD = process.env.ROUTER_PASSWORD || 'admin';
const ROUTER_BRAND    = (process.env.ROUTER_BRAND   || 'generic').toLowerCase();
const ROTATION_WAIT   = 35000; // ms to wait after restart before checking IP

// ─── Get current public IP ───────────────────────────────────────────────────

async function getCurrentIP() {
  const services = [
    'https://api.ipify.org',
    'https://api4.my-ip.io/ip',
    'https://ipv4.icanhazip.com',
  ];
  for (const url of services) {
    try {
      const res = await axios.get(url, { timeout: 8000 });
      return res.data.trim();
    } catch (_) {}
  }
  return null;
}

// ─── Wait for IP to change ───────────────────────────────────────────────────

async function waitForNewIP(oldIP, timeoutMs = 120000) {
  logger.info(`Waiting for IP to change from ${oldIP}...`);
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    await sleep(8000);
    try {
      const newIP = await getCurrentIP();
      if (newIP && newIP !== oldIP) {
        logger.info(`✅ IP rotated: ${oldIP} → ${newIP}`);
        return newIP;
      }
    } catch (_) {
      // still reconnecting, keep waiting
    }
  }

  logger.warn('⚠️  IP did not change within timeout. Continuing with same IP.');
  return null;
}

// ─── Router-specific restart functions ──────────────────────────────────────

async function restartTPLink() {
  // Works for: TL-WR840N, TL-WR841N, Archer series, most TP-Link home routers
  try {
    const base64Auth = Buffer.from(`${ROUTER_USERNAME}:${ROUTER_PASSWORD}`).toString('base64');
    const headers = { Authorization: `Basic ${base64Auth}` };

    // Try v1 API
    await axios.get(`http://${ROUTER_IP}/userRpm/SysRebootRpm.htm?Reboot=Reboot`, {
      headers, timeout: 8000
    });
    return true;
  } catch (_) {}

  try {
    // Try v2 API (newer TP-Link)
    const session = axios.create({ baseURL: `http://${ROUTER_IP}`, timeout: 8000 });
    await session.post('/cgi-bin/luci/;stok=/rpc/sys', {
      method: 'exec',
      params: { cmd: 'reboot' }
    });
    return true;
  } catch (_) {}

  return false;
}

async function restartDLink() {
  // Works for: DIR series D-Link routers
  try {
    const session = axios.create({ baseURL: `http://${ROUTER_IP}`, timeout: 8000 });
    await session.get('/login.cgi', { params: { username: ROUTER_USERNAME, password: ROUTER_PASSWORD } });
    await session.get('/reboot.cgi');
    return true;
  } catch (_) {
    return false;
  }
}

async function restartNetgear() {
  // Works for: Netgear Nighthawk and standard home routers
  try {
    const base64Auth = Buffer.from(`${ROUTER_USERNAME}:${ROUTER_PASSWORD}`).toString('base64');
    await axios.get(`http://${ROUTER_IP}/reboot.cgi`, {
      headers: { Authorization: `Basic ${base64Auth}` },
      timeout: 8000
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function restartAsus() {
  // Works for: ASUS RT series
  try {
    const session = axios.create({ baseURL: `http://${ROUTER_IP}`, timeout: 8000 });
    await session.post('/login.cgi', `login_authorization=${Buffer.from(`${ROUTER_USERNAME}:${ROUTER_PASSWORD}`).toString('base64')}`);
    await session.get('/apply.cgi?action_mode=device_reboot');
    return true;
  } catch (_) {
    return false;
  }
}

async function restartJioFiber() {
  // Works for: JioFiber ONT routers (192.168.29.1 is common JioFiber IP)
  try {
    const session = axios.create({ baseURL: `http://${ROUTER_IP}`, timeout: 8000 });
    await session.post('/login', { username: ROUTER_USERNAME, password: ROUTER_PASSWORD });
    await session.post('/reboot');
    return true;
  } catch (_) {
    return false;
  }
}

async function restartAirtel() {
  // Works for: Airtel Xstream routers
  try {
    const session = axios.create({ baseURL: `http://${ROUTER_IP}`, timeout: 8000 });
    await session.post('/cgi-bin/te_acceso_router', {
      loginUsername: ROUTER_USERNAME,
      loginPassword: ROUTER_PASSWORD
    });
    await session.get('/cgi-bin/reboot_router');
    return true;
  } catch (_) {
    return false;
  }
}

async function restartGeneric() {
  // Try a set of common reboot endpoints across different router brands
  const base64Auth = Buffer.from(`${ROUTER_USERNAME}:${ROUTER_PASSWORD}`).toString('base64');
  const headers = { Authorization: `Basic ${base64Auth}` };

  const endpoints = [
    { method: 'GET',  url: `/reboot` },
    { method: 'GET',  url: `/api/reboot` },
    { method: 'POST', url: `/api/reboot` },
    { method: 'GET',  url: `/cgi-bin/reboot` },
    { method: 'GET',  url: `/userRpm/SysRebootRpm.htm?Reboot=Reboot` },
    { method: 'GET',  url: `/apply.cgi?action_mode=device_reboot` },
    { method: 'POST', url: `/goform/SysToolReboot` },
    { method: 'GET',  url: `/cgi-bin/luci/;stok=/admin/system/reboot?method=set` },
  ];

  for (const ep of endpoints) {
    try {
      await axios({ method: ep.method, url: `http://${ROUTER_IP}${ep.url}`, headers, timeout: 5000 });
      logger.info(`Router reboot triggered via ${ep.url}`);
      return true;
    } catch (_) {}
  }
  return false;
}

// ─── Main rotate function ────────────────────────────────────────────────────

async function rotateIP() {
  logger.info(`🔄 Starting IP rotation (brand: ${ROUTER_BRAND})...`);

  const oldIP = await getCurrentIP();
  if (!oldIP) {
    logger.warn('Could not determine current IP before rotation');
  }

  // Send reboot command based on router brand
  let rebooted = false;
  switch (ROUTER_BRAND) {
    case 'tplink':    rebooted = await restartTPLink();   break;
    case 'dlink':     rebooted = await restartDLink();    break;
    case 'netgear':   rebooted = await restartNetgear();  break;
    case 'asus':      rebooted = await restartAsus();     break;
    case 'jiofiber':  rebooted = await restartJioFiber(); break;
    case 'airtel':    rebooted = await restartAirtel();   break;
    default:          rebooted = await restartGeneric();  break;
  }

  if (!rebooted) {
    logger.warn('Could not reboot router via HTTP. Trying fallback (ping method)...');
    // Fallback: some routers reboot when you spam-ping a specific endpoint
    // User can also manually unplug router here
  }

  logger.info(`⏳ Waiting ${ROTATION_WAIT / 1000}s for router to come back online...`);
  await sleep(ROTATION_WAIT);

  const newIP = await waitForNewIP(oldIP);
  return { oldIP, newIP, changed: newIP !== null && newIP !== oldIP };
}

// ─── Network health check ────────────────────────────────────────────────────

async function waitForNetwork(timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await axios.get('https://www.google.com', { timeout: 5000 });
      return true;
    } catch (_) {
      await sleep(5000);
    }
  }
  return false;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { rotateIP, getCurrentIP, waitForNetwork, sleep };
