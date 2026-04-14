const airlineSelect = document.getElementById('airlineSelect');
const processTypeSelect = document.getElementById('processTypeSelect');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileName = document.getElementById('fileName');
const uploadBtn = document.getElementById('uploadBtn');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const resetBtn = document.getElementById('resetBtn');
const refreshLogsBtn = document.getElementById('refreshLogsBtn');
const downloadLiveBtn = document.getElementById('downloadLiveBtn');
const downloadResultsBtn = document.getElementById('downloadResultsBtn');
const downloadRefundBtn = document.getElementById('downloadRefundBtn');

const runBadge = document.getElementById('runBadge');
const progressBar = document.getElementById('progressBar');
const progressText = document.getElementById('progressText');
const progressPct = document.getElementById('progressPct');
const statPending = document.getElementById('statPending');
const statDone = document.getElementById('statDone');
const statFailed = document.getElementById('statFailed');
const statRetry = document.getElementById('statRetry');
const logsBox = document.getElementById('logsBox');
const toast = document.getElementById('toast');

let selectedFile = null;
let toastTimer = null;

function currentProcessType() {
  return processTypeSelect && processTypeSelect.value === 'refund' ? 'refund' : 'status';
}

function applyProcessUi() {
  const mode = currentProcessType();
  const isRefund = mode === 'refund';
  startBtn.textContent = isRefund ? 'Start Refund Run' : 'Start Run';
  if (downloadLiveBtn) downloadLiveBtn.classList.toggle('hidden', isRefund);
  if (downloadResultsBtn) downloadResultsBtn.classList.toggle('hidden', isRefund);
  if (downloadRefundBtn) downloadRefundBtn.classList.toggle('hidden', !isRefund);
}

function setBadge(type, text) {
  runBadge.className = `pill ${type}`;
  runBadge.textContent = text;
}

function notify(msg) {
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 2500);
}

function setBusy(button, isBusy, busyText, idleText) {
  button.disabled = isBusy;
  button.textContent = isBusy ? busyText : idleText;
}

dropzone.addEventListener('dragover', e => {
  e.preventDefault();
  dropzone.classList.add('drag');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('drag');
});

dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) {
    selectedFile = file;
    fileName.textContent = file.name;
    notify(`Selected ${file.name}`);
  }
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files && fileInput.files[0];
  selectedFile = file || null;
  fileName.textContent = selectedFile ? selectedFile.name : 'No file selected';
  if (selectedFile) notify(`Selected ${selectedFile.name}`);
});

async function toBase64(file) {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function api(path, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));

  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }

  return data;
}

uploadBtn.addEventListener('click', async () => {
  try {
    if (!selectedFile) {
      notify('Select an Excel file first.');
      return;
    }

    setBusy(uploadBtn, true, 'Uploading...', 'Upload & Import');

    const base64 = await toBase64(selectedFile);
    const data = await api('/api/upload', 'POST', {
      airline: airlineSelect.value,
      processType: currentProcessType(),
      filename: selectedFile.name,
      contentBase64: base64,
      replaceExisting: true,
    });

    notify(`Imported successfully. Pending: ${data.stats.pending}`);
    await refreshStatus();
    await refreshLogs();
  } catch (err) {
    notify(err.message);
  } finally {
    setBusy(uploadBtn, false, 'Uploading...', 'Upload & Import');
  }
});

startBtn.addEventListener('click', async () => {
  try {
    const processType = currentProcessType();
    await api('/api/run/start', 'POST', {
      airline: airlineSelect.value,
      processType,
    });
    notify(processType === 'refund' ? 'Refund run started.' : 'Status run started.');
    await refreshStatus();
  } catch (err) {
    notify(err.message);
  }
});

stopBtn.addEventListener('click', async () => {
  try {
    await api('/api/run/stop', 'POST');
    notify('Stop requested.');
    await refreshStatus();
  } catch (err) {
    notify(err.message);
  }
});

resetBtn.addEventListener('click', async () => {
  try {
    const ok = window.confirm('Reset all processed jobs back to pending?');
    if (!ok) return;

    await api('/api/jobs/reset-all', 'POST');
    notify('All jobs reset to pending.');
    await refreshStatus();
  } catch (err) {
    notify(err.message);
  }
});

refreshLogsBtn.addEventListener('click', refreshLogs);
if (processTypeSelect) {
  processTypeSelect.addEventListener('change', applyProcessUi);
}

async function refreshStatus() {
  try {
    const data = await api('/api/status');
    const s = data.stats;

    const total = s.total || 0;
    const done = s.done || 0;
    const pct = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

    progressBar.style.width = `${pct}%`;
    progressText.textContent = `${done} / ${total}`;
    progressPct.textContent = `${pct}%`;

    statPending.textContent = s.pending || 0;
    statDone.textContent = s.done || 0;
    statFailed.textContent = s.failed || 0;
    statRetry.textContent = s.retry || 0;

    if (data.run && data.run.running) {
      setBadge('running', 'Running');
      startBtn.disabled = true;
      stopBtn.disabled = false;
    } else if (data.run && data.run.exitCode && data.run.exitCode !== 0) {
      setBadge('error', 'Error');
      startBtn.disabled = false;
      stopBtn.disabled = true;
    } else {
      setBadge('idle', 'Idle');
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }

    const runningProcess = data.run && data.run.running ? data.run.processType : currentProcessType();
    if (runningProcess === 'refund') {
      if (downloadLiveBtn) downloadLiveBtn.classList.add('hidden');
      if (downloadResultsBtn) downloadResultsBtn.classList.add('hidden');
      if (downloadRefundBtn) downloadRefundBtn.classList.remove('hidden');
    }
  } catch (_) {
    setBadge('error', 'Offline');
  }
}

async function refreshLogs() {
  try {
    const data = await api('/api/logs');
    logsBox.textContent = (data.logs || []).join('\n');
    logsBox.scrollTop = logsBox.scrollHeight;
  } catch (_) {
    logsBox.textContent = 'Unable to fetch logs';
  }
}

setInterval(refreshStatus, 2500);
setInterval(refreshLogs, 4000);
applyProcessUi();
refreshStatus();
refreshLogs();
