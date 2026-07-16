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
import crypto from 'node:crypto';
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

// --- security limits -------------------------------------------------------
//
// The bridge is a local endpoint that can write files and launch Photoshop, so
// treat every inbound byte as hostile: bind loopback-only, require a pairing
// token, and bound anything we parse before handing it to a decoder.

const MAX_PAYLOAD = 64 * 1024 * 1024;      // WebSocket frame cap (~48MB of PSD after base64)
const MAX_PSD_BYTES = 48 * 1024 * 1024;    // reject bigger PSDs before parsing
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_DIM = 30000;                     // PSD format ceiling
const MAX_PIXELS = 80e6;                   // guards decompression bombs (80 MP)
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
// Bind BOTH loopback addresses: Figma's manifest only allows hostnames (not IP
// literals), so the plugin must dial "localhost" — which may resolve to ::1 or
// 127.0.0.1 depending on the machine. Both are loopback; neither is on the LAN.
const LOOPBACK_BIND = ['127.0.0.1', '::1'];
// Figma's plugin iframe is sandboxed, so it reports Origin "null". That's
// spoofable by any sandboxed iframe, so this only blocks naive drive-by pages —
// the pairing token is the real gate. Non-browser clients send no Origin.
const ALLOWED_ORIGINS = new Set(['null', 'https://www.figma.com', 'https://figma.com']);

// Validate a PSD's header *before* parsing it. Reading width/height straight
// from the 26-byte header lets us reject absurd/hostile files cheaply.
export function assertSafePsd(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 26) throw new Error('Not a valid PSD file');
  if (buf.toString('ascii', 0, 4) !== '8BPS') throw new Error('Not a PSD file (bad signature)');
  if (buf.length > MAX_PSD_BYTES) {
    throw new Error(`PSD too large: ${(buf.length / 1048576) | 0}MB (max ${MAX_PSD_BYTES / 1048576}MB)`);
  }
  const height = buf.readUInt32BE(14);
  const width = buf.readUInt32BE(18);
  if (width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM) {
    throw new Error(`Refusing PSD with unreasonable dimensions ${width}×${height}`);
  }
  if (width * height > MAX_PIXELS) {
    throw new Error(`Refusing PSD with ${((width * height) / 1e6) | 0}MP (max ${MAX_PIXELS / 1e6}MP)`);
  }
  return { width, height };
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export function assertSafePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) throw new Error('Not a valid PNG');
  if (!buf.subarray(0, 8).equals(PNG_MAGIC)) throw new Error('Not a PNG file');
  if (buf.length > MAX_PNG_BYTES) throw new Error(`PNG too large (max ${MAX_PNG_BYTES / 1048576}MB)`);
  return true;
}

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

// Flatten a .psd to a canvas. Prefers Photoshop's own composite (captures
// effects/blend modes), but flattens the layers itself when that composite is
// missing or unusable — so the user never has to enable "Maximize PSD
// Compatibility".
function renderCompositeCanvas(buf) {
  const psd = readPsd(buf, { skipThumbnail: true });
  const hasLayers = !!(psd.children && psd.children.length);
  if (psd.canvas && compositeUsable(psd.canvas, hasLayers)) return psd.canvas;
  return renderLayers(psd);
}

export function compositePng(buf) {
  return renderCompositeCanvas(buf).toBuffer('image/png');
}

// Flattened preview for Figma: same composite, but scaled down so neither
// dimension exceeds Figma's 4096px image limit. Returns the PNG + its size.
export function compositePreview(buf, maxDim = 4096) {
  const src = renderCompositeCanvas(buf);
  const scale = Math.min(1, maxDim / Math.max(src.width, src.height));
  if (scale === 1) {
    return { png: src.toBuffer('image/png'), width: src.width, height: src.height };
  }
  const width = Math.round(src.width * scale);
  const height = Math.round(src.height * scale);
  const c = createCanvas(width, height);
  c.getContext('2d').drawImage(src, 0, 0, width, height);
  return { png: c.toBuffer('image/png'), width, height };
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
  const clients = new Set(); // authenticated Figma plugin UIs only
  const staging = new Map(); // importId -> { buf, at }, awaiting a Figma node id
  const servers = []; // one per loopback address
  let running = false;
  let wss = null;

  // --- pairing token -------------------------------------------------------
  // Anyone on this machine (including a web page in the user's browser) can
  // reach a loopback port, so commands require a shared secret the user copies
  // from the app once. Stored 0600 in the user's own data dir.
  const tokenFile = path.join(dataDir, 'token');
  function loadOrCreateToken() {
    try {
      const t = fs.readFileSync(tokenFile, 'utf8').trim();
      if (t.length >= 32) return t;
    } catch {}
    const t = crypto.randomBytes(24).toString('hex');
    fs.writeFileSync(tokenFile, t, { mode: 0o600 });
    try { fs.chmodSync(tokenFile, 0o600); } catch {}
    return t;
  }
  const token = loadOrCreateToken();
  function validToken(candidate) {
    if (typeof candidate !== 'string') return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(token);
    // Length check first — timingSafeEqual throws on length mismatch.
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  const loadIndex = () => {
    try { return JSON.parse(fs.readFileSync(indexFile, 'utf8')); } catch { return {}; }
  };
  const saveIndex = (ix) => fs.writeFileSync(indexFile, JSON.stringify(ix, null, 2));
  const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 60);

  // index.json lives on disk; never let a tampered entry escape psdDir.
  const safeEntryFile = (file) =>
    (typeof file === 'string' && file && !file.includes('..') && file === path.basename(file)) ? file : null;

  // Drop staged imports that were never bound (bounded memory).
  const STAGING_TTL_MS = 10 * 60 * 1000;
  function pruneStaging() {
    const now = Date.now();
    for (const [id, v] of staging) if (now - v.at > STAGING_TTL_MS) staging.delete(id);
  }

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
        const buf = fs.readFileSync(psdPath);
        assertSafePsd(buf); // the file on disk could have been swapped
        const { png } = compositePreview(buf);
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
    if (typeof nodeId !== 'string' || !nodeId) throw new Error('Invalid nodeId');
    const ix = loadIndex();
    let entry = ix[nodeId];
    const entryFile = entry && safeEntryFile(entry.file);
    const existing = entryFile && fs.existsSync(path.join(psdDir, entryFile));

    if (force || !existing) {
      const pngBuf = Buffer.from(String(png || ''), 'base64');
      assertSafePng(pngBuf);
      const file = `${sanitize(name || 'image')}_${sanitize(nodeId)}.psd`;
      await buildPsdFromPng(pngBuf, path.join(psdDir, file));
      entry = { file, name };
      ix[nodeId] = entry;
      saveIndex(ix);
      log(`Created PSD for "${name || nodeId}"`);
    } else {
      log(`Reopening PSD for "${name || nodeId}" (your layers are preserved)`);
    }

    const finalFile = safeEntryFile(entry.file);
    if (!finalFile) throw new Error('Invalid PSD entry');
    const psdPath = path.join(psdDir, finalFile);
    watch(nodeId, psdPath);
    openInPhotoshop(psdPath, photoshopApp);
    broadcast({ t: 'opened', nodeId, file: finalFile });
  }

  // Step 1 of "Place PSD": render a flat preview, keep the layered PSD staged
  // until the plugin creates a Figma node and tells us its id.
  function handleImport({ psd, name }) {
    const buf = Buffer.from(String(psd || ''), 'base64');
    assertSafePsd(buf); // signature + size + dimensions, before any parsing
    pruneStaging();
    const { png, width, height } = compositePreview(buf);
    const importId = `imp_${crypto.randomBytes(9).toString('hex')}`;
    staging.set(importId, { buf, at: Date.now() });
    broadcast({ t: 'imported', importId, name, width, height, png: png.toString('base64') });
    log(`Imported layered PSD "${name}" (${width}×${height}px) — placing in Figma`);
  }

  // Step 2: bind the staged PSD to the node the plugin just created, so future
  // "Edit in Photoshop" on that image opens these original layers.
  function handleBind({ importId, nodeId, name }) {
    if (typeof nodeId !== 'string' || !nodeId) throw new Error('Invalid nodeId');
    const staged = staging.get(importId);
    if (!staged) { log(`Bind failed: import ${importId} expired`); return; }
    staging.delete(importId);
    const file = `${sanitize(name || 'image')}_${sanitize(nodeId)}.psd`;
    fs.writeFileSync(path.join(psdDir, file), staged.buf);
    const ix = loadIndex();
    ix[nodeId] = { file, name };
    saveIndex(ix);
    log(`Linked layers to the placed image — Edit in Photoshop now opens the original PSD`);
  }

  function start() {
    if (servers.length) return;
    const loopbackHost = (req) =>
      LOOPBACK_HOSTS.has(String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, ''));

    const httpHandler = (req, res) => {
      // Anti-DNS-rebinding: a page that resolves its own domain to 127.0.0.1
      // still sends its own Host header, so require a loopback Host.
      if (!loopbackHost(req)) { res.writeHead(403); res.end('Forbidden'); return; }
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, platform: process.platform }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Figshop bridge is running.');
    };

    // noServer mode so one WebSocket server can accept upgrades from both
    // loopback listeners. The handshake checks that verifyClient used to do
    // now happen here.
    wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

    const rejectUpgrade = (socket) => {
      try { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch {}
      socket.destroy();
    };
    const onUpgrade = (req, socket, head) => {
      if (!loopbackHost(req)) return rejectUpgrade(socket);
      // Browsers always send Origin; native clients send none. Blocks a
      // drive-by page outright — the token still gates everything else.
      const origin = req.headers.origin;
      if (origin !== undefined && !ALLOWED_ORIGINS.has(origin)) return rejectUpgrade(socket);
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    };

    wss.on('connection', (ws) => {
      // Unauthenticated until it proves it holds the pairing token: it receives
      // no broadcasts and can run no commands until then.
      let authed = false;
      const authTimer = setTimeout(() => {
        if (!authed) {
          try { ws.send(JSON.stringify({ t: 'auth-required' })); } catch {}
          ws.close(4401, 'unauthorized');
        }
      }, 5000);

      ws.on('message', async (data) => {
        let msg;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        if (!authed) {
          if (msg.t === 'auth' && validToken(msg.token)) {
            authed = true;
            clearTimeout(authTimer);
            clients.add(ws);
            ws.send(JSON.stringify({ t: 'ready', platform: process.platform }));
            log('Figma plugin paired and connected.');
          } else {
            try { ws.send(JSON.stringify({ t: 'auth-required' })); } catch {}
            ws.close(4401, 'unauthorized');
          }
          return;
        }

        try {
          if (msg.t === 'open') await handleOpen(msg);
          else if (msg.t === 'import') handleImport(msg);
          else if (msg.t === 'bind') handleBind(msg);
        } catch (e) {
          log(`Error: ${e.message}`);
          ws.send(JSON.stringify({ t: 'error', nodeId: msg?.nodeId, message: e.message }));
        }
      });

      const cleanup = () => { clearTimeout(authTimer); clients.delete(ws); };
      ws.on('close', cleanup);
      ws.on('error', cleanup);
    });

    // Loopback only: never reachable from the LAN/Wi-Fi. We bind 127.0.0.1 and
    // ::1 so "localhost" reaches us regardless of how it resolves.
    for (const host of LOOPBACK_BIND) {
      const s = http.createServer(httpHandler);
      s.on('upgrade', onUpgrade);
      // ::1 can be unavailable (IPv6 disabled) — that's fine, 127.0.0.1 serves.
      s.on('error', (e) => log(`Listen ${host}:${port} failed: ${e.code || e.message}`));
      s.listen(port, host, () => {
        if (!running) { running = true; emitter.emit('status', { running: true, port }); }
        log(`Bridge listening on ${host}:${port} (loopback only)`);
      });
      servers.push(s);
    }
  }

  function stop() {
    for (const w of watchers.values()) w.close();
    watchers.clear();
    for (const c of clients) try { c.close(); } catch {}
    clients.clear();
    if (wss) { wss.close(); wss = null; }
    for (const s of servers) { try { s.close(); } catch {} }
    servers.length = 0;
    running = false;
    emitter.emit('status', { running: false, port });
    log('Bridge stopped.');
  }

  return Object.assign(emitter, {
    start, stop,
    get running() { return running; },
    port, photoshopApp, dataDir, psdDir,
    token, // shown/copied by the app so the user can pair the plugin
  });
}
