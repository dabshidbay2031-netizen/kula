// Headless interactive site review.
// Visits each hash-route, waits for render, captures a screenshot,
// and records console errors, page errors, and failed network requests.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// Overridable so the sweep can follow the dev server's actual port — a
// hardcoded port silently "passes" every route against a refused connection.
const BASE = process.env.BASE_URL ?? 'http://localhost:3001';
const SHOT_DIR = path.resolve('review-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

// Routes pulled from views/routes.tsx. Hash-based SPA -> use #/route.
const ROUTES = [
  { name: 'home',         path: '/' },
  { name: 'explore',      path: '/#/explore' },
  { name: 'search',       path: '/#/search' },
  { name: 'wishlist',     path: '/#/wishlist' },
  { name: 'orders',       path: '/#/orders' },
  { name: 'pos',          path: '/#/pos' },
  { name: 'suppliers',    path: '/#/suppliers' },
  { name: 'dashboard',    path: '/#/dashboard' },
  { name: 'inventory',    path: '/#/inventory' },
  { name: 'customers',    path: '/#/customers' },
  { name: 'billing',      path: '/#/billing' },
  { name: 'settings',     path: '/#/settings' },
  { name: 'notifications',path: '/#/notifications' },
  { name: 'chat',         path: '/#/chat' },
  { name: 'checkout',     path: '/#/checkout' },
  { name: 'privacy',      path: '/#/privacy' },
  { name: 'terms',        path: '/#/terms' },
  { name: 'about',        path: '/#/about' },
  { name: 'contact',      path: '/#/contact' },
  { name: 'login',        path: '/#/auth/login' },
  { name: 'signup',       path: '/#/auth/signup' },
  { name: 'admin',        path: '/#/admin' },
  { name: 'profile',      path: '/#/profile' },
];

const results = [];

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  deviceScaleFactor: 1,
  ignoreHTTPSErrors: true,
});

const page = await ctx.newPage();
page.setDefaultTimeout(15000);

const consoleErrors = [];
const pageErrors = [];
const failedReqs = [];

page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => pageErrors.push(err.message));
page.on('requestfailed', (req) => {
  failedReqs.push(`${req.method()} ${req.url()} :: ${req.failure()?.errorText}`);
});

for (const r of ROUTES) {
  consoleErrors.length = 0;
  pageErrors.length = 0;
  failedReqs.length = 0;

  const url = BASE + r.path;
  let status = 'ok';
  let bodyText = '';
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
    // Give SPA a moment to mount + fetch data.
    await page.waitForTimeout(2500);
    // Wait for *something* to render in the app root.
    await page.waitForFunction(() => {
      const el = document.getElementById('__next') || document.body;
      return el && el.innerText && el.innerText.trim().length > 20;
    }, { timeout: 10000 }).catch(() => { status = 'empty'; });
    bodyText = (await page.evaluate(() => document.body.innerText)).slice(0, 400).replace(/\s+/g, ' ').trim();
    if (resp && !resp.ok()) status = `http_${resp.status()}`;
  } catch (e) {
    status = `nav_error: ${e.message.split('\n')[0].slice(0, 120)}`;
  }

  const shot = path.join(SHOT_DIR, `${r.name}.png`);
  try {
    await page.screenshot({ path: shot, fullPage: true });
  } catch {}

  results.push({
    route: r.name,
    path: r.path,
    status,
    consoleErrors: [...consoleErrors],
    pageErrors: [...pageErrors],
    failedReqs: [...failedReqs],
    preview: bodyText,
    shot,
  });
  console.log(`[${r.name.padEnd(14)}] ${status}  errors=${consoleErrors.length}/${pageErrors.length}  failedReq=${failedReqs.length}`);
}

await browser.close();

fs.writeFileSync(
  path.resolve('review-report.json'),
  JSON.stringify(results, null, 2)
);

// Summary to stdout
const totalErrors = results.reduce((a, r) => a + r.pageErrors.length, 0);
const totalConsole = results.reduce((a, r) => a + r.consoleErrors.length, 0);
const totalFailed = results.reduce((a, r) => a + r.failedReqs.length, 0);
const empty = results.filter(r => r.status === 'empty').map(r => r.route);
console.log('\n=== SUMMARY ===');
console.log(`Routes checked: ${results.length}`);
console.log(`Page errors:    ${totalErrors}`);
console.log(`Console errors: ${totalConsole}`);
console.log(`Failed requests:${totalFailed}`);
console.log(`Empty renders:  ${empty.length ? empty.join(', ') : 'none'}`);
console.log(`Screenshots:    ${SHOT_DIR}`);
console.log(`Full report:     review-report.json`);
