// Figshop menu-bar app (Electron main process, CommonJS).
//
// Electron bundles Node, so this ships as a self-contained .app/.dmg with NO
// Node install required on the user's machine. It runs the same bridge core as
// the CLI (bridge.mjs, synced from ../bridge/bridge.js) and exposes a tray menu.

const { app, Tray, Menu, nativeImage, shell, dialog, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const DATA_DIR = path.join(os.homedir(), '.figshop');
const LOG_FILE = path.join(DATA_DIR, 'bridge.log');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// Everything below works with zero configuration. The optional
// ~/.figshop/config.json only exists for power users:
//   { "port": 3900, "photoshopApp": "<app name (mac) or Photoshop.exe path (win)>" }
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}
const PORT = cfg.port || 3900;
const PHOTOSHOP_APP = cfg.photoshopApp || null; // null = auto-detect installed Photoshop

const saveConfig = () => { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2)); } catch {} };

const logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
const fileLog = (m) => logStream.write(`[${new Date().toISOString()}] ${m}\n`);

let tray = null;
let bridge = null;
let status = { running: false };

// Menu-bar-only app: no Dock icon, no windows.
if (process.platform === 'darwin') app.setActivationPolicy('accessory');

// Only one instance — a second bridge would fight for the port.
if (!app.requestSingleInstanceLock()) app.quit();

// Register the figshop:// scheme so the Figma plugin can launch this helper on
// demand (e.g. after install, or if the user quit it). The bridge starts on
// launch regardless, so handling the URL itself needs no extra work.
app.setAsDefaultProtocolClient('figshop');
app.on('open-url', (event) => { event.preventDefault(); }); // macOS deep-link

app.whenReady().then(async () => {
  tray = new Tray(trayImage());
  tray.setToolTip('Figshop bridge');
  updateMenu();

  // Start the bridge FIRST. Nothing may block this — see the login prompt below.
  try {
    const core = await import(pathToFileURL(path.join(__dirname, 'bridge.mjs')).href);
    bridge = core.createBridge({ port: PORT, photoshopApp: PHOTOSHOP_APP, version: app.getVersion() });
    bridge.on('log', fileLog);
    bridge.on('status', (s) => { status = s; updateMenu(); });
    bridge.start();
    updateMenu(); // the pairing-code item needs the bridge
  } catch (e) {
    fileLog('Failed to start bridge: ' + (e && e.stack || e));
    status = { running: false, error: String(e && e.message || e) };
    updateMenu();
  }

  // Launch-at-login is opt-in: ask once and honour the answer. (Earlier builds
  // enabled it silently; this gives those users an explicit choice too.)
  // Deliberately NOT awaited: this is a dock-less menu-bar app, so a modal
  // dialog can sit unseen behind other windows — awaiting it here previously
  // stopped the bridge from ever starting.
  if (!cfg.loginPrompted) {
    cfg.loginPrompted = true;
    saveConfig();
    dialog.showMessageBox({
      type: 'question',
      buttons: ['Not now', 'Start at login'],
      defaultId: 1,
      cancelId: 0,
      message: 'Start Figshop automatically at login?',
      detail:
        'Figshop must be running for the Figma plugin to reach Photoshop. ' +
        'You can change this any time from the menu-bar icon.',
    }).then(({ response }) => {
      app.setLoginItemSettings({ openAtLogin: response === 1 });
      updateMenu();
    }).catch((e) => fileLog('Login prompt failed: ' + e.message));
  }
});

app.on('second-instance', () => {}); // ignore; tray already shows status

function trayImage() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', 'iconTemplate.png'));
  img.setTemplateImage(true); // adapts to light/dark menu bar
  return img;
}

function updateMenu() {
  if (!tray) return;
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  const statusLabel = status.error
    ? `⚠ ${status.error}`
    : status.running ? `● Running on :${PORT}` : '○ Stopped';

  tray.setContextMenu(Menu.buildFromTemplate([
    { label: statusLabel, enabled: false },
    { label: `Photoshop: ${PHOTOSHOP_APP || 'auto-detected'}`, enabled: false },
    { type: 'separator' },
    status.running
      ? { label: 'Stop bridge', click: () => bridge && bridge.stop() }
      : { label: 'Start bridge', click: () => bridge && bridge.start() },
    {
      label: 'Open at login',
      type: 'checkbox',
      checked: openAtLogin,
      click: (item) => { app.setLoginItemSettings({ openAtLogin: item.checked }); updateMenu(); },
    },
    { type: 'separator' },
    {
      label: 'Copy pairing code',
      enabled: !!(bridge && bridge.token),
      // The plugin must present this token before the bridge accepts any
      // command, so a random local process/web page can't drive Photoshop.
      click: () => {
        clipboard.writeText(bridge.token);
        fileLog('Pairing code copied to clipboard.');
        dialog.showMessageBox({
          type: 'info',
          message: 'Pairing code copied',
          detail: 'Paste it into the Figma plugin panel to pair. You only need to do this once.',
          buttons: ['OK'],
        });
      },
    },
    { type: 'separator' },
    { label: 'Open log…', click: () => shell.openPath(LOG_FILE) },
    { label: 'Open PSD folder…', click: () => shell.openPath(path.join(DATA_DIR, 'psd')) },
    { type: 'separator' },
    { label: 'Quit Figshop', click: () => { if (bridge) bridge.stop(); app.quit(); } },
  ]));
}
