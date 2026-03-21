const { app, BrowserWindow, Tray, Menu, nativeImage, dialog } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const net = require('net');
const http = require('http');
const fs = require('fs');

let mainWindow = null;
let tray = null;
let workerProcess = null;
let workerPort = null;
let isQuitting = false;

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
  // Try preferred port first
  for (let port = 37777; port <= 37800; port++) {
    if (await isPortFree(port)) return port;
  }
  // Fallback: random port
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

  const workerScript = path.join(__dirname, 'plugin', 'scripts', 'worker-service.cjs');
  if (!fs.existsSync(workerScript)) {
    dialog.showErrorBox('Worker not found',
      `Cannot find worker-service.cjs at:\n${workerScript}\n\nRun 'npm run build' first.`);
    app.quit();
    return null;
  }

  const env = {
    ...process.env,
    CLAUDE_MEM_WORKER_PORT: String(port),
  };

  workerProcess = spawn(bun, [workerScript], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
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
    // Force kill after 3s
    setTimeout(() => {
      if (workerProcess && !workerProcess.killed) {
        workerProcess.kill('SIGKILL');
      }
    }, 3000);
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
