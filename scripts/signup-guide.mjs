// Walks the business-account signup flow and captures a screenshot at every
// step, overlaying a red arrow on the element to click / fill next.
//
// Run against the running dev server (npm run dev on :3001):
//   node scripts/signup-guide.mjs
//
// Output: signup-guide/01-*.png ... 08-*.png
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const BASE = 'http://localhost:3001';
const OUT  = path.resolve('signup-guide');
fs.mkdirSync(OUT, { recursive: true });

// Mobile viewport (matches the iPhone-class PWA the app is built for).
const VW = 390, VH = 844;

const CREDENTIALS = {
  name:     'TechVault Store',
  email:    'demo@hamarmall.com',
  password: 'demo123',
};

/**
 * Inject an in-page SVG overlay drawing a red arrow whose tip meets the target
 * element's bounding box, so the screenshot shows where to click/fill without
 * needing an image-processing dependency.
 */
async function annotate(page, targetSelector, tipSide = 'top') {
  const el = await page.$(targetSelector);
  if (!el) return false;
  const box = await el.boundingBox();
  if (!box) return false;

  let tipX, tipY, tailX, tailY;
  if (tipSide === 'top') {
    tipX = box.x + box.width / 2; tipY = box.y + 2;
    tailX = tipX; tailY = Math.max(8, box.y - 95);
  } else if (tipSide === 'right') {
    tipX = box.x + box.width - 2; tipY = box.y + box.height / 2;
    tailX = box.x + box.width + 95; tailY = tipY;
  } else if (tipSide === 'left') {
    tipX = box.x + 2; tipY = box.y + box.height / 2;
    tailX = Math.max(8, box.x - 95); tailY = tipY;
  } else {
    tipX = box.x + box.width / 2; tipY = box.y + box.height - 2;
    tailX = tipX; tailY = box.y + box.height + 95;
  }

  await page.addStyleTag({ content: `#__annot{position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;}` });
  await page.evaluate(({ tailX, tailY, tipX, tipY }) => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('id', '__annot');
    svg.setAttribute('width', window.innerWidth);
    svg.setAttribute('height', window.innerHeight);
    svg.setAttribute('viewBox', `0 0 ${window.innerWidth} ${window.innerHeight}`);
    const defs = document.createElementNS(ns, 'defs');
    defs.innerHTML = `<marker id="ahead" markerWidth="10" markerHeight="10" refX="6" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10 z" fill="#E11D2A"/></marker>`;
    svg.appendChild(defs);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', tailX); line.setAttribute('y1', tailY);
    line.setAttribute('x2', tipX);  line.setAttribute('y2', tipY);
    line.setAttribute('stroke', '#E11D2A');
    line.setAttribute('stroke-width', '5');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('marker-end', 'url(#ahead)');
    svg.appendChild(line);
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', tailX); dot.setAttribute('cy', tailY);
    dot.setAttribute('r', '6'); dot.setAttribute('fill', '#E11D2A');
    svg.appendChild(dot);
    document.body.appendChild(svg);
  }, { tailX, tailY, tipX, tipY });
  return true;
}

async function clearAnnotation(page) {
  await page.evaluate(() => document.getElementById('__annot')?.remove());
}

async function shot(page, filename, annotateOpts) {
  if (annotateOpts) {
    const ok = await annotate(page, annotateOpts.selector, annotateOpts.tipSide);
    if (!ok) console.warn(`  [warn] annotation target missing: ${annotateOpts.selector}`);
  }
  await page.screenshot({ path: path.join(OUT, filename), type: 'png' });
  await clearAnnotation(page);
  console.log(`  ✓ ${filename}`);
}

async function waitReady(page) {
  // Wait for the app shell (AuthProvider) to resolve so views don't flash.
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(600);
}

(async () => {
  console.log('Launching headless Chromium…');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: VW, height: VH },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  });
  page.setDefaultTimeout(15000);

  // Surface any console errors during the run.
  page.on('console', m => { if (m.type() === 'error') console.warn('  [console.error]', m.text().slice(0, 160)); });

  // ── Step 1: Signup landing / method chooser ──────────────────────────
  console.log('Step 1 — method chooser');
  await page.goto(`${BASE}/#/auth/signup`, { waitUntil: 'domcontentloaded' });
  await waitReady(page);
  // The "Email & Password" method button.
  await shot(page, '01-signup-method.png', { selector: '.auth-method-btn:has-text("Email")', tipSide: 'left' });

  // ── Step 2: Pick Email → account-type step ───────────────────────────
  console.log('Step 2 — account type');
  await page.locator('.auth-method-btn').first().click();
  await page.waitForTimeout(500);
  // "Business" account-type button.
  await shot(page, '02-account-type.png', { selector: '.acct-type-btn:has-text("Business")', tipSide: 'right' });

  // ── Step 3: Select Business, then Continue ───────────────────────────
  console.log('Step 3 — select business + continue');
  await page.locator('.acct-type-btn', { hasText: 'Business' }).click();
  await page.waitForTimeout(300);
  await shot(page, '03-business-selected.png', { selector: '.btn-primary:has-text("Continue")', tipSide: 'top' });

  // ── Step 4: Details form (Business Name) ─────────────────────────────
  console.log('Step 4 — business name field');
  await page.locator('.btn-primary', { hasText: 'Continue' }).click();
  await page.waitForTimeout(400);
  await shot(page, '04-business-name.png', { selector: 'input[placeholder="TechVault Store"]', tipSide: 'right' });
  await page.locator('input[placeholder="TechVault Store"]').fill(CREDENTIALS.name);

  // ── Step 5: Email field ──────────────────────────────────────────────
  console.log('Step 5 — email field');
  await shot(page, '05-email.png', { selector: 'input[type="email"]', tipSide: 'right' });
  await page.locator('input[type="email"]').fill(CREDENTIALS.email);

  // ── Step 6: Password + confirm ───────────────────────────────────────
  console.log('Step 6 — password fields');
  await shot(page, '06-password.png', { selector: 'input[placeholder="Min. 6 characters"]', tipSide: 'right' });
  await page.locator('input[placeholder="Min. 6 characters"]').fill(CREDENTIALS.password);
  await page.locator('input[placeholder="Repeat password"]').fill(CREDENTIALS.password);

  // ── Step 7: Agree to Terms ───────────────────────────────────────────
  console.log('Step 7 — agree to terms');
  await shot(page, '07-agree-terms.png', { selector: 'input[type="checkbox"]', tipSide: 'right' });
  await page.locator('input[type="checkbox"]').check();

  // ── Step 8: Create Account button ────────────────────────────────────
  console.log('Step 8 — create account');
  await shot(page, '08-create-account.png', { selector: '.btn-primary:has-text("Create Account")', tipSide: 'top' });

  // Submit and wait for the post-signup redirect (to /billing) or the
  // "check email" screen if email confirmation is on.
  await page.locator('.btn-primary', { hasText: 'Create Account' }).click();
  console.log('  submitting… (waiting for redirect or confirmation screen)');

  // Either we land on /billing (success) or the "check your email" card appears.
  try {
    await page.waitForURL(/#\/(billing|profile)/, { timeout: 15000 }).catch(() => {});
    await waitReady(page);
    await shot(page, '09-success-billing.png'); // plain shot, no arrow
    console.log('  ✓ business account created, redirected to billing');
  } catch {
    // maybe the "check email" confirmation screen
    const checkEmail = await page.locator('text=Check your email').count().catch(() => 0);
    if (checkEmail > 0) {
      await shot(page, '09-confirm-email.png');
      console.log('  ✓ signup submitted — email confirmation required');
    } else {
      await shot(page, '09-result.png');
      console.log('  ⚠ submitted, but did not detect the expected success/confirmation screen');
    }
  }

  await browser.close();
  console.log(`\nDone. Screenshots in ${OUT}`);
})().catch(e => { console.error(e); process.exit(1); });
