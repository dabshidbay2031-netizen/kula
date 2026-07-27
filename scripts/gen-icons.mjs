/**
 * Generate every icon size from the master SVGs.
 *
 *   node scripts/gen-icons.mjs
 *
 * Renders public/icons/icon.svg (and icon-maskable.svg) in headless Chromium
 * and screenshots each required size. Playwright is already a dev dependency,
 * so this needs no image toolchain and produces real, correctly-sized PNGs
 * rather than one file the browser rescales badly.
 *
 * Re-run after changing either SVG — the PNGs are build output, not artwork.
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ICONS = path.resolve('public/icons');
const master   = fs.readFileSync(path.join(ICONS, 'icon.svg'), 'utf8');
const maskable = fs.readFileSync(path.join(ICONS, 'icon-maskable.svg'), 'utf8');

/** iOS refuses transparency on the home screen — it composites onto black. */
const OPAQUE_BG = '#4F46E5';

const TARGETS = [
  // Browser tab / bookmarks
  { file: 'favicon-16.png',           size: 16,  svg: master },
  { file: 'favicon-32.png',           size: 32,  svg: master },
  { file: 'favicon-48.png',           size: 48,  svg: master },
  // iOS home screen. 180 is the only size current iPhones ask for; the
  // smaller ones keep older iPads sharp.
  { file: 'apple-touch-icon.png',     size: 180, svg: master, opaque: true },
  { file: 'apple-touch-icon-152.png', size: 152, svg: master, opaque: true },
  { file: 'apple-touch-icon-167.png', size: 167, svg: master, opaque: true },
  // Android / PWA install
  { file: 'icon-192.png',             size: 192, svg: master },
  { file: 'icon-256.png',             size: 256, svg: master },
  { file: 'icon-384.png',             size: 384, svg: master },
  { file: 'icon-512.png',             size: 512, svg: master },
  // Android adaptive (launcher crops these to its own shape)
  { file: 'icon-maskable-192.png',    size: 192, svg: maskable, opaque: true },
  { file: 'icon-maskable-512.png',    size: 512, svg: maskable, opaque: true },
];

const page = await (await chromium.launch()).newPage();

for (const t of TARGETS) {
  await page.setViewportSize({ width: t.size, height: t.size });
  await page.setContent(
    `<html><body style="margin:0;background:${t.opaque ? OPAQUE_BG : 'transparent'}">
       <div style="width:${t.size}px;height:${t.size}px">${t.svg}</div>
     </body></html>`,
    { waitUntil: 'load' },
  );
  // The SVG must fill the box exactly, or the screenshot is letterboxed.
  await page.evaluate(() => {
    const s = document.querySelector('svg');
    if (s) { s.setAttribute('width', '100%'); s.setAttribute('height', '100%'); s.style.display = 'block'; }
  });
  await page.screenshot({
    path: path.join(ICONS, t.file),
    omitBackground: !t.opaque,
  });
  const kb = (fs.statSync(path.join(ICONS, t.file)).size / 1024).toFixed(1);
  console.log(`  ${t.file.padEnd(26)} ${String(t.size).padStart(3)}px  ${kb} KB${t.opaque ? '  (opaque)' : ''}`);
}

await page.context().browser().close();

/**
 * favicon.ico — browsers still request /favicon.ico by name, and a 404 there
 * is a wasted round trip on every cold load.
 *
 * The ICO container can hold a PNG directly (Vista onwards), which every
 * browser in use understands. That avoids pulling in a BMP encoder just to
 * wrap one 32x32 image.
 */
const png = fs.readFileSync(path.join(ICONS, 'favicon-32.png'));
const header = Buffer.alloc(22);
header.writeUInt16LE(0, 0);            // reserved
header.writeUInt16LE(1, 2);            // type: 1 = icon
header.writeUInt16LE(1, 4);            // one image in this file
header.writeUInt8(32, 6);              // width
header.writeUInt8(32, 7);              // height
header.writeUInt8(0, 8);               // palette size (0 = truecolour)
header.writeUInt8(0, 9);               // reserved
header.writeUInt16LE(1, 10);           // colour planes
header.writeUInt16LE(32, 12);          // bits per pixel
header.writeUInt32LE(png.length, 14);  // image size
header.writeUInt32LE(22, 18);          // offset to the image data
fs.writeFileSync(path.resolve('app/favicon.ico'), Buffer.concat([header, png]));
console.log(`  ${'app/favicon.ico'.padEnd(26)}  32px  ${(png.length / 1024).toFixed(1)} KB`);

console.log(`\nWrote ${TARGETS.length} icons to public/icons/ + app/favicon.ico`);
