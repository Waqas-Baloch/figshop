// Figshop bridge — CLI entry point.
// Thin wrapper around the shared core in bridge.js so the double-click
// launchers and `npm start` keep working. The Electron app uses the same core.

import { readFileSync } from 'node:fs';
import { createBridge } from './bridge.js';

let version = '0';
try { version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url))).version; } catch {}

const bridge = createBridge({
  port: Number(process.env.FIGSHOP_PORT || 3900),
  photoshopApp: process.env.PHOTOSHOP_APP || null, // null = auto-detect installed Photoshop
  version,
});

bridge.on('log', (m) => console.log('[figshop]', m));
bridge.start();
console.log(`[figshop] PSD store: ${bridge.psdDir}`);
