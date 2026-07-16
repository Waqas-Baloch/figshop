// Adversarial tests for the hardened bridge. Runs an isolated instance in a
// temp data dir and tries to break in.
import { createBridge } from './bridge.js';
import { WebSocket } from 'ws';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writePsd } from 'ag-psd';
import { createCanvas } from '@napi-rs/canvas';

const PORT = 3921;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'figshop-sec-'));
const bridge = createBridge({ port: PORT, dataDir: tmp, photoshopApp: '__noop__' });
bridge.on('log', () => {});
bridge.start();
await new Promise((r) => setTimeout(r, 400));

let pass = true;
const ok = (n, c, extra = '') => { console.log((c ? '  PASS ' : '  FAIL ') + n, extra); if (!c) pass = false; };

// helper: open a ws, return {events, close}
const dial = (opts = {}) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, opts.protocols, opts.wsOpts);
  const out = { msgs: [], closeCode: null, error: null, ws };
  ws.on('message', (d) => { try { out.msgs.push(JSON.parse(d)); } catch {} });
  ws.on('close', (c) => { out.closeCode = c; resolve(out); });
  ws.on('error', (e) => { out.error = e.message; });
  ws.on('open', () => { if (opts.onOpen) opts.onOpen(ws); });
  setTimeout(() => { try { ws.close(); } catch {}; resolve(out); }, 2500);
});

console.log('\n1) Network exposure');
{
  const lan = Object.values(os.networkInterfaces()).flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal);
  if (!lan) { console.log('  SKIP (no LAN interface)'); }
  else {
    const reachable = await new Promise((res) => {
      const s = net.connect({ host: lan.address, port: PORT });
      s.on('connect', () => { s.destroy(); res(true); });
      s.on('error', () => res(false));
      setTimeout(() => { s.destroy(); res(false); }, 1500);
    });
    ok(`not reachable from LAN ip ${lan.address} (loopback-only)`, !reachable);
  }
}

console.log('\n2) Authentication');
{
  const noAuth = await dial({ onOpen: (ws) => ws.send(JSON.stringify({ t: 'open', nodeId: 'x', name: 'x', png: '' })) });
  ok('command without auth is rejected (closed 4401)', noAuth.closeCode === 4401, `code=${noAuth.closeCode}`);
  ok('server told us auth is required', noAuth.msgs.some((m) => m.t === 'auth-required'));

  const badTok = await dial({ onOpen: (ws) => ws.send(JSON.stringify({ t: 'auth', token: 'deadbeef'.repeat(6) })) });
  ok('wrong token is rejected (closed 4401)', badTok.closeCode === 4401, `code=${badTok.closeCode}`);

  const good = await dial({ onOpen: (ws) => ws.send(JSON.stringify({ t: 'auth', token: bridge.token })) });
  ok('correct token is accepted (ready)', good.msgs.some((m) => m.t === 'ready'));
}

console.log('\n3) Browser drive-by / DNS-rebinding');
{
  const evilOrigin = await dial({ wsOpts: { origin: 'https://evil.example.com' } });
  ok('hostile Origin rejected at handshake', /403|Unexpected server response/i.test(evilOrigin.error || ''), evilOrigin.error || '');

  const nullOrigin = await dial({ wsOpts: { origin: 'null' }, onOpen: (ws) => ws.send(JSON.stringify({ t: 'auth', token: bridge.token })) });
  ok("Figma's sandboxed iframe (Origin null) + token still works", nullOrigin.msgs.some((m) => m.t === 'ready'));

  const evilHost = await dial({ wsOpts: { headers: { host: 'evil.example.com' } } });
  ok('non-loopback Host rejected (anti DNS-rebinding)', /403|Unexpected server response/i.test(evilHost.error || ''), evilHost.error || '');
}

console.log('\n4) Malicious payloads (authenticated attacker)');
const authed = () => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const out = { msgs: [], ws };
  ws.on('message', (d) => { const m = JSON.parse(d); out.msgs.push(m); if (m.t === 'ready') resolve(out); });
  ws.on('open', () => ws.send(JSON.stringify({ t: 'auth', token: bridge.token })));
});
{
  const c = await authed();
  const errs = () => c.msgs.filter((m) => m.t === 'error').map((m) => m.message);

  c.ws.send(JSON.stringify({ t: 'import', psd: Buffer.from('not a psd at all').toString('base64'), name: 'evil' }));
  await new Promise((r) => setTimeout(r, 300));
  ok('non-PSD bytes rejected, no crash', errs().some((m) => /not a psd|signature|valid PSD/i.test(m)), errs().slice(-1)[0] || '');

  // decompression bomb: valid header claiming ~900 megapixels
  const bomb = Buffer.alloc(64);
  bomb.write('8BPS', 0, 'ascii');
  bomb.writeUInt16BE(1, 4); bomb.writeUInt16BE(3, 12);
  bomb.writeUInt32BE(29999, 14); bomb.writeUInt32BE(29999, 18);
  bomb.writeUInt16BE(8, 22); bomb.writeUInt16BE(3, 24);
  c.ws.send(JSON.stringify({ t: 'import', psd: bomb.toString('base64'), name: 'bomb' }));
  await new Promise((r) => setTimeout(r, 300));
  ok('pixel bomb rejected before parsing', errs().some((m) => /MP|dimension/i.test(m)), errs().slice(-1)[0] || '');

  // path traversal via nodeId + name
  const cv = createCanvas(8, 8); cv.getContext('2d').fillStyle = '#fff'; cv.getContext('2d').fillRect(0, 0, 8, 8);
  const png = cv.toBuffer('image/png').toString('base64');
  c.ws.send(JSON.stringify({ t: 'open', nodeId: '../../../../tmp/pwned', name: '../../../../tmp/pwned', png, force: true }));
  await new Promise((r) => setTimeout(r, 500));
  ok('path traversal contained (nothing written outside psd dir)', !fs.existsSync('/tmp/pwned.psd'));
  const inside = fs.readdirSync(path.join(tmp, 'psd'));
  ok('sanitized filename stayed in psd dir', inside.length > 0 && inside.every((f) => !f.includes('/') && !f.includes('..')), inside.join(','));
  c.ws.close();
}

console.log('\n5) Token file permissions');
{
  const m = (fs.statSync(path.join(tmp, 'token')).mode & 0o777).toString(8);
  ok('token file is 0600', m === '600', `mode=${m}`);
  ok('token is high-entropy (>=48 hex chars)', /^[0-9a-f]{48,}$/.test(bridge.token), `${bridge.token.length} chars`);
}

console.log('\n6) Feature still works once paired (Place PSD round-trip)');
{
  const rect = (w, h, col) => { const c = createCanvas(w, h); c.getContext('2d').fillStyle = col; c.getContext('2d').fillRect(0, 0, w, h); return c; };
  const psdBuf = Buffer.from(writePsd({
    width: 40, height: 30,
    children: [
      { name: 'base', left: 0, top: 0, right: 40, bottom: 30, canvas: rect(40, 30, '#cc2222') },
      { name: 'corner', left: 0, top: 0, right: 16, bottom: 16, canvas: rect(16, 16, '#22bb66') },
    ],
  }));
  const c = await authed();
  const nodeId = 'sec:' + Date.now();
  const got = (pred) => new Promise((res) => {
    const h = (d) => { const m = JSON.parse(d); if (pred(m)) { c.ws.off('message', h); res(m); } };
    c.ws.on('message', h);
    setTimeout(() => res(null), 3000);
  });

  c.ws.send(JSON.stringify({ t: 'import', psd: psdBuf.toString('base64'), name: 'Art.psd' }));
  const imported = await got((m) => m.t === 'imported');
  ok('authenticated import returns a preview', !!imported && imported.width === 40 && imported.height === 30);

  c.ws.send(JSON.stringify({ t: 'bind', importId: imported.importId, nodeId, name: 'Art.psd' }));
  await new Promise((r) => setTimeout(r, 250));
  c.ws.send(JSON.stringify({ t: 'open', nodeId, name: 'Art.psd' }));
  const opened = await got((m) => m.t === 'opened');
  ok('edit reopens the bound PSD', !!opened);
  if (opened) {
    const onDisk = fs.readFileSync(path.join(tmp, 'psd', opened.file));
    ok('original layered PSD preserved byte-for-byte', onDisk.equals(psdBuf));
  }
  c.ws.close();
}

bridge.stop();
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (pass ? 'ALL SECURITY CHECKS PASS ✓' : 'SOME CHECKS FAILED ✗'));
process.exit(pass ? 0 : 1);
