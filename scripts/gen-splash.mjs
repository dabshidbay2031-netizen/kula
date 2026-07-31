/**
 * Generate iOS launch screens.
 *
 * Android synthesises a splash from the manifest; iOS does NOT — without
 * apple-touch-startup-image it shows a blank white screen from tap until React
 * boots. iOS only accepts an EXACT pixel match for the device, so each size is
 * rendered separately.
 *
 * Sizes cover every iPhone Apple currently supports, portrait only (a phone
 * launching an app in landscape falls back to white, which is acceptable —
 * covering both doubles the asset count for a rare case).
 */
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const OUT = 'C:/Users/ruwey/Downloads/mogarenta/mogarenta-next/public/splash';
mkdirSync(OUT, { recursive: true });

/* [cssWidth, cssHeight, dpr] — the pixel size is w*dpr × h*dpr. */
const DEVICES = [
  [430, 932, 3], // 15/16 Pro Max, 14 Pro Max
  [402, 874, 3], // 16 Pro
  [393, 852, 3], // 14 Pro, 15, 16
  [428, 926, 3], // 12/13 Pro Max
  [390, 844, 3], // 12/13/14
  [375, 812, 3], // X, XS, 11 Pro, 12/13 mini
  [414, 896, 2], // XR, 11
  [414, 896, 3], // XS Max, 11 Pro Max
  [375, 667, 2], // SE 2/3, 8
];

const BG = '#1257E5';

/** The three-bar mark + wordmark, centred — the manifest's own brand colour. */
const page = (w, h) => `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:${BG};}
  .wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.round(w*0.055)}px}
  .bars{display:flex;flex-direction:column;gap:${Math.round(w*0.028)}px;align-items:flex-start}
  .bar{height:${Math.round(w*0.038)}px;background:#fff;border-radius:${Math.round(w*0.019)}px}
  .b1{width:${Math.round(w*0.30)}px}.b2{width:${Math.round(w*0.21)}px}.b3{width:${Math.round(w*0.13)}px}
  .name{color:#fff;font-family:'Arial Black','Helvetica Neue',Impact,sans-serif;
        font-size:${Math.round(w*0.088)}px;letter-spacing:-.02em}
</style>
<div class="wrap">
  <div class="bars"><div class="bar b1"></div><div class="bar b2"></div><div class="bar b3"></div></div>
  <div class="name">Hamar Mall</div>
</div>`;

const browser = await chromium.launch();
const made = [];

for (const [w, h, dpr] of DEVICES) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  const p = await ctx.newPage();
  await p.setContent(page(w, h), { waitUntil: 'load' });
  const file = `splash-${w * dpr}x${h * dpr}.png`;
  await p.screenshot({ path: `${OUT}/${file}` });
  await ctx.close();
  made.push({ file, w, h, dpr });
}
await browser.close();

/* The <link> tags, ready to paste into the document head. */
const links = made.map(({ file, w, h, dpr }) =>
  `<link rel="apple-touch-startup-image" href="/splash/${file}" `
  + `media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait)" />`
).join('\n');

writeFileSync(OUT + '/links.html', links);
console.log(JSON.stringify({ generated: made.length, files: made.map(m => m.file) }, null, 1));
