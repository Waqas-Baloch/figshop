// Generates the Figma Community listing assets: a 128×128 icon and a 1920×960
// cover. Uses @napi-rs/canvas, so run it where that dep exists, e.g. from the
// desktop folder:  (cd ../../desktop && node ../figma-plugin/store/make-assets.mjs)
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.env.ASSET_OUT || path.resolve(import.meta.dirname);
fs.mkdirSync(OUT, { recursive: true });

// Register a system font for the cover text (first one that exists).
let FONT = 'sans-serif';
for (const f of [
  '/System/Library/Fonts/SFNS.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
]) {
  if (fs.existsSync(f)) { GlobalFonts.registerFromPath(f, 'Brand'); FONT = 'Brand'; break; }
}

const BLUE = '#0d99ff';
const PURPLE = '#7b61ff';
const PS = '#001e36';
const PS_ACCENT = '#31a8ff';

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
function glyph(ctx, cx, cy, s, color) {
  const w = s * 0.5;
  ctx.lineWidth = s * 0.09;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  rr(ctx, cx - s * 0.34, cy - s * 0.34, w, w, s * 0.12); ctx.stroke();
  rr(ctx, cx - s * 0.04, cy - s * 0.04, w, w, s * 0.12); ctx.fill();
}

// --- icon 128×128 ---
{
  const S = 128;
  const c = createCanvas(S, S);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, BLUE); g.addColorStop(1, PURPLE);
  rr(x, 0, 0, S, S, S * 0.22); x.fillStyle = g; x.fill();
  glyph(x, S / 2, S / 2, S * 0.52, 'white');
  fs.writeFileSync(path.join(OUT, 'icon-128.png'), c.toBuffer('image/png'));
}

// --- cover 1920×960 ---
{
  const W = 1920, H = 960;
  const c = createCanvas(W, H);
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#0b1530'); g.addColorStop(1, '#16234d');
  x.fillStyle = g; x.fillRect(0, 0, W, H);

  // soft glow
  const rg = x.createRadialGradient(W / 2, H * 0.42, 60, W / 2, H * 0.42, 900);
  rg.addColorStop(0, 'rgba(13,153,255,0.20)'); rg.addColorStop(1, 'rgba(13,153,255,0)');
  x.fillStyle = rg; x.fillRect(0, 0, W, H);

  // app tiles: Figma  →  Photoshop
  const tile = (cx, cy, s, fill, draw) => {
    rr(x, cx - s / 2, cy - s / 2, s, s, s * 0.22);
    x.fillStyle = fill; x.fill();
    draw(cx, cy, s);
  };
  const rowY = H * 0.40, s = 150;
  // Figma tile (gradient + glyph)
  const fg = x.createLinearGradient(0, rowY - s / 2, 0, rowY + s / 2);
  fg.addColorStop(0, BLUE); fg.addColorStop(1, PURPLE);
  tile(W / 2 - 230, rowY, s, fg, (cx, cy) => glyph(x, cx, cy, s * 0.5, 'white'));
  // arrow
  x.strokeStyle = 'rgba(255,255,255,0.85)'; x.lineWidth = 10; x.lineCap = 'round';
  x.beginPath(); x.moveTo(W / 2 - 110, rowY); x.lineTo(W / 2 + 110, rowY); x.stroke();
  x.beginPath(); x.moveTo(W / 2 + 70, rowY - 34); x.lineTo(W / 2 + 112, rowY); x.lineTo(W / 2 + 70, rowY + 34); x.stroke();
  // Photoshop tile (Ps)
  tile(W / 2 + 230, rowY, s, PS, (cx, cy) => {
    x.fillStyle = PS_ACCENT; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.font = `bold ${s * 0.42}px ${FONT}`;
    x.fillText('Ps', cx, cy + s * 0.02);
  });

  // title + tagline
  x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = 'white';
  x.font = `bold 116px ${FONT}`;
  x.fillText('Figma To Photoshop', W / 2, H * 0.66);
  x.globalAlpha = 0.85; x.font = `42px ${FONT}`;
  x.fillText('Edit Figma images in Photoshop — your changes sync back automatically.', W / 2, H * 0.78);
  x.globalAlpha = 1;

  fs.writeFileSync(path.join(OUT, 'cover-1920x960.png'), c.toBuffer('image/png'));
}

console.log('listing assets written to', OUT);
