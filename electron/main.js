const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const net = require('net');
const http = require('http');
const fs = require('fs');

let mainWindow = null;
let tray = null;
let workerProcess = null;
let agentDaemonProcess = null;
let workerPort = null;
let isQuitting = false;

const FIXED_PORT = 37777;

// ─── Kill Ghost Processes ──────────────────────────────────
async function killGhostProcesses() {
  console.log('[electron] Killing ghost processes on port range 37777-37800...');
  try {
    // Get all PIDs listening on our port range
    const result = execSync('netstat -ano 2>nul', { encoding: 'utf8', timeout: 5000 });
    const pidsToKill = new Set();

    for (const line of result.split('\n')) {
      const match = line.match(/127\.0\.0\.1:(377[7-9]\d|3780[0-9])\s+.*LISTENING\s+(\d+)/);
      if (match) {
        const pid = parseInt(match[2]);
        if (pid > 0 && pid !== process.pid) pidsToKill.add(pid);
      }
    }

    for (const pid of pidsToKill) {
      try {
        console.log(`[electron] Killing ghost PID ${pid}`);
        execSync(`taskkill /F /PID ${pid} 2>nul`, { timeout: 3000 });
      } catch {} // Ignore if already dead
    }

    if (pidsToKill.size > 0) {
      console.log(`[electron] Killed ${pidsToKill.size} ghost process(es). Waiting for ports to free...`);
      await new Promise(r => setTimeout(r, 2000)); // Wait for OS to release ports
    } else {
      console.log('[electron] No ghost processes found');
    }
  } catch (err) {
    console.error('[electron] Ghost cleanup failed:', err.message);
  }
}

// ─── Port Discovery ────────────────────────────────────────
function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => { server.close(); resolve(true); });
    server.listen(port, '127.0.0.1');
  });
}

async function findFreePort() {
  // Always try the fixed port first
  if (await isPortFree(FIXED_PORT)) return FIXED_PORT;

  // Port taken — kill ghost processes and retry
  console.log(`[electron] Port ${FIXED_PORT} is taken. Attempting ghost cleanup...`);
  await killGhostProcesses();

  // Retry fixed port after cleanup
  if (await isPortFree(FIXED_PORT)) {
    console.log(`[electron] Port ${FIXED_PORT} freed after ghost cleanup`);
    return FIXED_PORT;
  }

  // Still taken — try a small range
  for (let port = FIXED_PORT + 1; port <= FIXED_PORT + 10; port++) {
    if (await isPortFree(port)) {
      console.log(`[electron] Using fallback port ${port}`);
      return port;
    }
  }

  // Last resort: random port
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

// ─── Health Check ──────────────────────────────────────────
function waitForHealth(port, maxWait = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      if (Date.now() - start > maxWait) {
        return reject(new Error(`Worker did not start within ${maxWait / 1000}s`));
      }
      const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 2000 }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.status === 'ok') return resolve(port);
          } catch {}
          setTimeout(check, 500);
        });
      });
      req.on('error', () => setTimeout(check, 500));
      req.on('timeout', () => { req.destroy(); setTimeout(check, 500); });
    };
    check();
  });
}

// ─── Find Bun ──────────────────────────────────────────────
function findBun() {
  // Check common locations
  const candidates = [
    path.join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun.exe'),
    path.join(process.env.USERPROFILE || '', '.bun', 'bin', 'bun'),
    'bun', // PATH
  ];
  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" --version`, { stdio: 'ignore' });
      return candidate;
    } catch {}
  }
  return null;
}

// ─── Worker Lifecycle ──────────────────────────────────────
async function startWorker() {
  const bun = findBun();
  if (!bun) {
    dialog.showErrorBox('bun not found',
      'claude-mem requires bun to run the worker service.\n\n' +
      'Install bun: https://bun.sh\n\n' +
      'Then restart claude-mem.');
    app.quit();
    return null;
  }

  const port = await findFreePort();
  console.log(`[electron] Starting worker on port ${port} with bun: ${bun}`);

  // Try installed marketplace plugin first (has node_modules), fallback to local
  const marketplaceDir = path.join(process.env.USERPROFILE || '', '.claude', 'plugins', 'marketplaces', 'thedotmack');
  const localDir = path.join(__dirname, 'plugin');

  let workerScript = path.join(marketplaceDir, 'plugin', 'scripts', 'worker-service.cjs');
  let workerCwdBase = marketplaceDir;

  if (!fs.existsSync(workerScript)) {
    workerScript = path.join(localDir, 'scripts', 'worker-service.cjs');
    workerCwdBase = localDir;
  }

  if (!fs.existsSync(workerScript)) {
    dialog.showErrorBox('Worker not found',
      `Cannot find worker-service.cjs.\n\nRun 'npm run build && npm run sync-marketplace:force' first.`);
    app.quit();
    return null;
  }

  const env = {
    ...process.env,
    CLAUDE_MEM_WORKER_PORT: String(port),
  };

  // Delete stale PID file so the worker doesn't think another instance is running
  const pidFile = path.join(process.env.USERPROFILE || '', '.claude-mem', 'worker.pid');
  try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch {}

  console.log(`[electron] Worker script: ${workerScript}`);
  console.log(`[electron] Worker cwd: ${workerCwdBase}`);

  workerProcess = spawn(bun, [workerScript], {
    env,
    cwd: workerCwdBase,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });

  workerProcess.stdout.on('data', (data) => {
    console.log(`[worker] ${data.toString().trim()}`);
  });

  workerProcess.stderr.on('data', (data) => {
    console.error(`[worker:err] ${data.toString().trim()}`);
  });

  workerProcess.on('exit', (code) => {
    console.log(`[worker] Exited with code ${code}`);
    if (!isQuitting) {
      // Worker crashed — restart
      console.log('[electron] Worker crashed, restarting in 3s...');
      setTimeout(() => startWorker().then(p => { workerPort = p; if (mainWindow) mainWindow.loadURL(`http://127.0.0.1:${p}`); }), 3000);
    }
  });

  console.log(`[electron] Waiting for worker health on port ${port}...`);
  await waitForHealth(port);
  console.log(`[electron] Worker healthy on port ${port}`);
  workerPort = port;
  return port;
}

function killWorker() {
  if (workerProcess && !workerProcess.killed) {
    console.log('[electron] Killing worker...');
    workerProcess.kill('SIGTERM');
    setTimeout(() => {
      if (workerProcess && !workerProcess.killed) workerProcess.kill('SIGKILL');
    }, 3000);
  }
}

// ─── Agent Daemon ──────────────────────────────────────────
function startAgentDaemon() {
  // Find the daemon script
  const daemonScript = path.join(__dirname, '..', 'scripts', 'agent-daemon.cjs');
  const fallbackScript = path.join(process.env.USERPROFILE || '', 'claude-mem', 'scripts', 'agent-daemon.cjs');
  const script = fs.existsSync(daemonScript) ? daemonScript : fallbackScript;

  if (!fs.existsSync(script)) {
    console.log('[electron] Agent daemon script not found, skipping');
    return;
  }

  console.log('[electron] Starting agent daemon...');
  agentDaemonProcess = spawn('node', [script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  agentDaemonProcess.stdout.on('data', (data) => {
    console.log(`[agent-daemon] ${data.toString().trim()}`);
  });
  agentDaemonProcess.stderr.on('data', (data) => {
    console.error(`[agent-daemon:err] ${data.toString().trim()}`);
  });
  agentDaemonProcess.on('exit', (code) => {
    console.log(`[agent-daemon] Exited with code ${code}`);
  });
}

function killAgentDaemon() {
  if (agentDaemonProcess && !agentDaemonProcess.killed) {
    console.log('[electron] Killing agent daemon...');
    agentDaemonProcess.kill('SIGTERM');
  }
}

// ─── Window ────────────────────────────────────────────────
function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'claude-mem',
    icon: path.join(__dirname, 'icon.png'),
    backgroundColor: '#0f0f23',
    titleBarStyle: 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  // Minimize to tray instead of closing
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// ─── System Tray ───────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  } else {
    // Fallback: create a simple colored square
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('claude-mem');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    { label: 'Open in Browser', click: () => { if (workerPort) require('electron').shell.openExternal(`http://localhost:${workerPort}`); } },
    { type: 'separator' },
    { label: `Port: ${workerPort || '...'}`, enabled: false },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.focus();
      } else {
        mainWindow.show();
      }
    }
  });
}

// ─── App Lifecycle ─────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    const port = await startWorker();
    if (!port) return;

    createWindow(port);
    createTray();
    startAgentDaemon();

    // Update tray with actual port
    if (tray) {
      const contextMenu = Menu.buildFromTemplate([
        { label: 'Show', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
        { label: 'Open in Browser', click: () => require('electron').shell.openExternal(`http://localhost:${port}`) },
        { type: 'separator' },
        { label: `Port: ${port}`, enabled: false },
        { type: 'separator' },
        { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
      ]);
      tray.setContextMenu(contextMenu);
    }
  } catch (err) {
    dialog.showErrorBox('Startup Error', `Failed to start claude-mem:\n\n${err.message}`);
    app.quit();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  killAgentDaemon();
  killWorker();
});

app.on('window-all-closed', () => {
  // Don't quit on window close — keep running in tray
});

app.on('activate', () => {
  if (mainWindow === null && workerPort) {
    createWindow(workerPort);
  } else if (mainWindow) {
    mainWindow.show();
  }
});
