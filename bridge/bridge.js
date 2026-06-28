// Figshop bridge core — reusable by both the CLI (server.js) and the
// Electron menu-bar app. Cross-platform (macOS + Windows) and config-free:
// it auto-opens the .psd in whatever Photoshop is installed, and composites
// the saved PSD itself so no Photoshop preference needs changing.
//
// Exposes createBridge() (EventEmitter with start()/stop()) plus the pure
// PSD<->PNG helpers (exported for tests).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import chokidar from 'chokidar';
import { writePsd, readPsd, initializeCanvas } from 'ag-psd';
import { createCanvas, loadImage, ImageData } from '@napi-rs/canvas';

// Teach ag-psd how to make canvases in Node (encode/decode pixels). Once per process.
initializeCanvas(createCanvas, (data, width, height) => {
  const canvas = createCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(data, width, height), 0, 0);
  return canvas;
});

// --- PSD -> PNG ------------------------------------------------------------

// Photoshop blend mode (ag-psd name) -> Canvas globalCompositeOperation.
const BLEND = {
  normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay',
  darken: 'darken', lighten: 'lighten', 'color dodge': 'color-dodge',
  'color burn': 'color-burn', 'hard light': 'hard-light', 'soft light': 'soft-light',
  difference: 'difference', exclusion: 'exclusion', hue: 'hue',
  saturation: 'saturation', color: 'color', luminosity: 'luminosity',
};

// Flatten a parsed PSD by drawing its layers bottom-to-top. Used only when the
// file has no stored composite (i.e. "Maximize PSD Compatibility" was off), so
// the user never has to touch that Photoshop setting.
export function renderLayers(psd) {
  const out = createCanvas(psd.width, psd.height);
  const ctx = out.getContext('2d');
  const draw = (layer) => {
    if (layer.hidden) return;
    if (layer.children) { layer.children.forEach(draw); return; } // group
    if (!layer.canvas) return;
    ctx.save();
    // ag-psd reports opacity on a 0–1 scale (1 = fully opaque).
    ctx.globalAlpha = layer.opacity == null ? 1 : Math.max(0, Math.min(1, layer.opacity));
    ctx.globalCompositeOperation = BLEND[(layer.blendMode || 'normal').toLowerCase()] || 'source-over';
    ctx.drawImage(layer.canvas, layer.left || 0, layer.top || 0);
    ctx.restore();
  };
  (psd.children || []).forEach(draw);
  return out;
}

// Is a stored composite worth trusting? Photoshop with "Maximize PSD
// Compatibility" OFF can leave a blank/solid composite that doesn't match the
// layers — so reject a fully-transparent one, or a uniform one when real
// layers exist (re-rendering the layers reproduces a truly-uniform image anyway).
function compositeUsable(canvas, hasLayers) {
  const c = createCanvas(canvas.width, canvas.height);
  c.getContext('2d').drawImage(canvas, 0, 0);
  const { data } = c.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let maxAlpha = 0;
  let uniform = true;
  const r0 = data[0], g0 = data[1], b0 = data[2], a0 = data[3];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > maxAlpha) maxAlpha = data[i + 3];
    if (uniform && (data[i] !== r0 || data[i + 1] !== g0 || data[i + 2] !== b0 || data[i + 3] !== a0)) {
      uniform = false;
    }
  }
  if (maxAlpha === 0) return false;       // fully transparent → not a real composite
  if (uniform && hasLayers) return false; // blank/degenerate composite over real layers
  return true;
}

// Read the flattened image out of a saved .psd as a PNG buffer. Prefers
// Photoshop's own composite (captures effects/blend modes), but flattens the
// layers itself when that composite is missing or unusable — so the user never
// has to enable "Maximize PSD Compatibility".
export function compositePng(buf) {
  const psd = readPsd(buf, { skipThumbnail: true });
  const hasLayers = !!(psd.children && psd.children.length);
  if (psd.canvas && compositeUsable(psd.canvas, hasLayers)) {
    return psd.canvas.toBuffer('image/png');
  }
  return renderLayers(psd).toBuffer('image/png');
}

// Wrap an incoming PNG in a fresh .psd with a single editable layer.
export async function buildPsdFromPng(pngBuf, psdPath) {
  const img = await loadImage(pngBuf);
  const canvas = createCanvas(img.width, img.height);
  canvas.getContext('2d').drawImage(img, 0, 0);
  const psd = {
    width: img.width,
    height: img.height,
    children: [{ name: 'Figma source', left: 0, top: 0, right: img.width, bottom: img.height, canvas }],
    canvas,
  };
  fs.writeFileSync(psdPath, Buffer.from(writePsd(psd, { generateThumbnail: true })));
}

// --- cross-platform: open a file in Photoshop ------------------------------

function findWindowsPhotoshop() {
  const bases = [process.env.ProgramW6432, process.env.ProgramFiles, 'C:\\Program Files'].filter(Boolean);
  for (const base of bases) {
    try {
      const adobe = path.join(base, 'Adobe');
      const dirs = fs.readdirSync(adobe).filter((d) => /photoshop/i.test(d)).sort().reverse();
      for (const d of dirs) {
        const exe = path.join(adobe, d, 'Photoshop.exe');
        if (fs.existsSync(exe)) return exe;
      }
    } catch {}
  }
  return null;
}

// Open the .psd in Photoshop without knowing its version. `appOverride` (from
// ~/.figshop/config.json) wins if set; otherwise we use the OS's handler.
function openInPhotoshop(psdPath, appOverride) {
  if (process.platform === 'darwin') {
    if (appOverride) return spawn('open', ['-a', appOverride, psdPath]);
    // Version-agnostic via bundle id; fall back to the default .psd handler.
    const p = spawn('open', ['-b', 'com.adobe.Photoshop', psdPath]);
    p.on('close', (code) => { if (code !== 0) spawn('open', [psdPath]); });
    return p;
  }
  if (process.platform === 'win32') {
    const exe = appOverride || findWindowsPhotoshop();
    if (exe) return spawn(exe, [psdPath]);
    return spawn('cmd', ['/c', 'start', '', psdPath]); // default .psd handler
  }
  return spawn('xdg-open', [psdPath]); // best effort elsewhere
}

// --- bridge ----------------------------------------------------------------

export function createBridge(options = {}) {
  const port = Number(options.port || 3900);
  const photoshopApp = options.photoshopApp || null; // null = auto-detect
  const dataDir = options.dataDir || path.join(os.homedir(), '.figshop');
  const psdDir = path.join(dataDir, 'psd');
  const indexFile = path.join(dataDir, 'index.json');
  fs.mkdirSync(psdDir, { recursive: true });

  const emitter = new EventEmitter();
  const watchers = new Map(); // nodeId -> chokidar watcher
  const clients = new Set(); // connected Figma plugin UIs
  let server = null;
  let wss = null;

  const loadIndex = () => {
    try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return {}; }
  };
  const saveIndex = (ix) => fs.writeFileSync(indexFile, JSON.stringify(ix, null, 2));
  const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 60);

  function broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const c of clients) if (c.readyState === 1) c.send(s);
  }
  function log(message) {
    emitter.emit('log', message);
    broadcast({ t: 'log', message });
  }

  function watch(nodeId, psdPath) {
    if (watchers.has(nodeId)) return;
    const w = chokidar.watch(psdPath, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    w.on('change', () => {
      try {
        const png = compositePng(fs.readFileSync(psdPath));
        broadcast({ t: 'updated', nodeId, png: png.toString('base64') });
        log(`Saved → pushed back to Figma: ${path.basename(psdPath)}`);
      } catch (e) {
        log(`Update failed: ${e.message}`);
        broadcast({ t: 'error', nodeId, message: e.message });
      }
    });
    watchers.set(nodeId, w);
  }

  async function handleOpen({ nodeId, name, png, force }) {
    const ix = loadIndex();
    let entry = ix[nodeId];
    const existing = entry && fs.existsSync(path.join(psdDir, entry.file));

    if (force || !existing) {
      const file = `${sanitize(name || 'image')}_${sanitize(nodeId)}.psd`;
      await buildPsdFromPng(Buffer.from(png, 'base64'), path.join(psdDir, file));
      entry = { file, name };
      ix[nodeId] = entry;
      saveIndex(ix);
      log(`Created PSD for "${name || nodeId}"`);
    } else {
      log(`Reopening PSD for "${name || nodeId}" (your layers are preserved)`);
    }

    const psdPath = path.join(psdDir, entry.file);
    watch(nodeId, psdPath);
    openInPhotoshop(psdPath, photoshopApp);
    broadcast({ t: 'opened', nodeId, file: entry.file });
  }

  function start() {
    if (server) return;
    server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, platform: process.platform }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Figshop bridge is running.');
    });
    wss = new WebSocketServer({ server, maxPayload: 256 * 1024 * 1024 });
    wss.on('connection', (ws) => {
      clients.add(ws);
      ws.send(JSON.stringify({ t: 'ready', platform: process.platform }));
      log('Figma plugin connected.');
      ws.on('message', async (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }
        try {
          if (msg.t === 'open') await handleOpen(msg);
        } catch (e) {
          log(`Error: ${e.message}`);
          ws.send(JSON.stringify({ t: 'error', nodeId: msg?.nodeId, message: e.message }));
        }
      });
      ws.on('close', () => clients.delete(ws));
    });
    server.on('error', (e) => log(`Server error: ${e.message}`));
    server.listen(port, () => {
      log(`Bridge listening on http://localhost:${port}`);
      emitter.emit('status', { running: true, port });
    });
  }

  function stop() {
    for (const w of watchers.values()) w.close();
    watchers.clear();
    for (const c of clients) try { c.close(); } catch {}
    clients.clear();
    if (wss) { wss.close(); wss = null; }
    if (server) { server.close(); server = null; }
    emitter.emit('status', { running: false, port });
    log('Bridge stopped.');
  }

  return Object.assign(emitter, {
    start, stop,
    get running() { return !!server; },
    port, photoshopApp, dataDir, psdDir,
  });
}
