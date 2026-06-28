// Generates the tray icon (template, adapts to menu-bar light/dark) and the
// app/dmg icon, drawn with the same canvas lib the bridge already uses.
import { createCanvas } from '@napi-rs/canvas';
import fs from 'node:fs';
import path from 'node:path';

const out = path.join(import.meta.dirname, 'assets');
fs.mkdirSync(out, { recursive: true });

const rr = (ctx, x, y, w, h, r) => {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

// Two overlapping rounded squares = "image handed between apps".
function glyph(size, color, fillSecond) {
  const c = createCanvas(size, size);
  const x = c.getContext('2d');
  const w = size * 0.46;
  x.lineWidth = size * 0.08;
  x.strokeStyle = color;
  x.fillStyle = color;
  rr(x, size * 0.10, size * 0.10, w, w, size * 0.11);
  x.stroke();
  rr(x, size * 0.44, size * 0.44, w, w, size * 0.11);
  if (fillSecond) x.fill(); else x.stroke();
  return c;
}

fs.writeFileSync(path.join(out, 'iconTemplate.png'), glyph(22, 'black', true).toBuffer('image/png'));
fs.writeFileSync(path.join(out, 'iconTemplate@2x.png'), glyph(44, 'black', true).toBuffer('image/png'));

// App / dmg icon: gradient tile with a white glyph.
const S = 512;
const c = createCanvas(S, S);
const x = c.getContext('2d');
const g = x.createLinearGradient(0, 0, S, S);
g.addColorStop(0, '#0d99ff');
g.addColorStop(1, '#7b61ff');
rr(x, 0, 0, S, S, S * 0.22);
x.fillStyle = g;
x.fill();
const inner = glyph(S, 'white', true);
x.drawImage(inner, 0, 0);
fs.writeFileSync(path.join(out, 'icon.png'), c.toBuffer('image/png'));

console.log('icons written to', out);
