// Role-based interactive test.
// Creates one account per type via the REAL signup UI (driving the live flow),
// then logs in and visits role-specific routes, capturing screenshots + errors.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// Match the other harnesses (backend-test*.mjs, review.mjs): default to the
// port in .claude/launch.json, overridable for a differently-hosted dev server.
const BASE = process.env.BASE_URL ?? 'http://localhost:3001';
const SHOT_DIR = path.resolve('role-shots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const STAMP = Date.now().toString().slice(-6);
const PASS = 'Test1234!';

// 4 account types. Email + name + the role-specific routes to visit once logged in.
const ACCOUNTS = [
  {
    type: 'user', label: 'Customer', icon: '👤',
    email: `cust_${STAMP}@mogarenta-test.com`,
    name: 'Test Customer',
    routes: ['/', '/#/wishlist', '/#/orders', '/#/notifications', '/#/profile', '/#/settings', '/#/search'],
    // Routes this role should NOT reach (expect redirect / sign-in gate):
    forbidden: ['/#/dashboard', '/#/inventory', '/#/pos', '/#/customers', '/#/admin'],
  },
  {
    type: 'business', label: 'Business', icon: '🏪',
    email: `biz_${STAMP}@mogarenta-test.com`,
    name: 'Test Business Store',
    routes: ['/#/dashboard', '/#/inventory', '/#/orders', '/#/pos', '/#/profile', '/#/settings', '/#/my-dashboard', '/#/billing'],
    forbidden: ['/#/admin'],
  },
  {
    type: 'supplier', label: 'Supplier', icon: '🏭',
    email: `sup_${STAMP}@mogarenta-test.com`,
    name: 'Test Wholesale Co',
    routes: ['/#/dashboard', '/#/inventory', '/#/suppliers', '/#/orders', '/#/profile', '/#/billing', '/#/my-dashboard'],
    forbidden: ['/#/admin'],
  },
  {
    type: 'agent', label: 'Field Agent', icon: '📋',
    email: `agent_${STAMP}@mogarenta-test.com`,
    name: 'Test Field Agent',
    routes: ['/#/my-dashboard', '/#/profile', '/#/settings', '/#/suppliers'],
    forbidden: ['/#/admin'],
  },
];

const results = [];

// Collect per-page diagnostics.
function attachCollectors(page, bucket) {
  page.on('console', m => { if (m.type() === 'error') bucket.consoleErrors.push(m.text().slice(0, 300)); });
  page.on('pageerror', e => bucket.pageErrors.push(e.message.slice(0, 300)));
  page.on('requestfailed', r => {
    const u = r.url();
    if (u.includes('/api/') || u.startsWith(BASE)) {
      bucket.failedReqs.push(`${r.method()} ${u.replace(BASE,'')} :: ${r.failure()?.errorText}`);
    }
  });
}

async function isVisible(page, text) {
  return page.getByText(text, { exact: false }).first().isVisible().catch(() => false);
}

// ── Signup through the real UI ──
async function signup(ctx, acct) {
  const bucket = { consoleErrors: [], pageErrors: [], failedReqs: [] };
  const page = await ctx.newPage();
  attachCollectors(page, bucket);
  await page.goto(`${BASE}/#/auth/signup`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // Step 0: pick Email method
  await page.locator('text=Email & Password').first().click();
  await page.waitForTimeout(900);

  // Step 1: pick account type button — match on the label substring to be tolerant
  // of the multi-line button text ("👤\nCustomer\nShop & track orders").
  await page.locator(`button:has-text("${acct.label}")`).first().click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Continue →' }).click();
  // Confirm the details step actually rendered before proceeding.
  try {
    await page.locator('input[type="email"]').waitFor({ state: 'visible', timeout: 12000 });
  } catch (e) {
    // Diagnose: dump state + screenshot so we can see why the form didn't appear.
    const body = (await page.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 400).replace(/\s+/g, ' ');
    const inputs = await page.$$eval('input', els => els.map(e => ({ type: e.type, ph: e.placeholder }))).catch(() => []);
    await page.screenshot({ path: path.join(SHOT_DIR, `_debug_${acct.type}_stepfail.png`) }).catch(() => {});
    throw new Error(`details step did not render. body="${body}" inputs=${JSON.stringify(inputs)}`);
  }
  await page.waitForTimeout(400);

  // Step 2: details — use type-based selectors (placeholders vary per account type).
  // The name input carries NO type attribute (it defaults to text), so
  // `input[type="text"]` does not match it — select the first field that is
  // neither the email nor a password box instead.
  await page.locator('input.form-input:not([type="email"]):not([type="password"])').first().fill(acct.name);
  await page.locator('input[type="email"]').fill(acct.email);
  // Password fields: order is [password, confirm-password]. First password input.
  await page.locator('input[type="password"]').nth(0).fill(PASS);
  await page.locator('input[type="password"]').nth(1).fill(PASS);
  await page.locator('input[type="checkbox"]').check();

  // Detect "Check your email" (confirmation on) vs instant login.
  let confirmationRequired = false;
  const createBtn = page.getByRole('button', { name: /Creating account|Create Account/ });
  await createBtn.click();

  // Wait for either the "check email" screen or the post-login nav.
  await Promise.race([
    page.getByText('Check your email', { exact: false }).waitFor({ timeout: 25000 }),
    page.waitForURL(`**${BASE}/**`, { timeout: 25000 }).catch(() => {}),
    page.waitForTimeout(25000),
  ]);
  confirmationRequired = await isVisible(page, 'Check your email');

  // Whether we logged in or not, persist session storage if present.
  let loggedIn = false;
  if (!confirmationRequired) {
    await page.waitForTimeout(2500); // let refreshAccount resolve
    loggedIn = await isVisible(page, 'Sign out') || await isVisible(page, 'Sign Out')
            || await page.locator('text=Sign in').first().isHidden().catch(() => false)
            || false;
  }

  return { page, bucket, confirmationRequired, loggedIn };
}

// ── Login through the real UI (used when re-entering as a role) ──
async function login(ctx, email) {
  const bucket = { consoleErrors: [], pageErrors: [], failedReqs: [] };
  const page = await ctx.newPage();
  attachCollectors(page, bucket);
  await page.goto(`${BASE}/#/auth/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(PASS);
  await page.getByRole('button', { name: /Sign in|Signing in/i }).click();
  await page.waitForTimeout(3000); // session + resolveAccount
  return { page, bucket };
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });

for (const acct of ACCOUNTS) {
  console.log(`\n=== ${acct.icon}  ${acct.label.toUpperCase()}  (${acct.type}) ===`);
  console.log(`    email: ${acct.email}`);
  const roleResult = { type: acct.type, label: acct.label, email: acct.email, name: acct.name,
                       signup: null, confirmationRequired: false, pages: [], gating: [] };

  // 1) Sign up
  try {
    const { bucket, confirmationRequired, loggedIn } = await signup(ctx, acct);
    roleResult.signup = { consoleErrors: bucket.consoleErrors, pageErrors: bucket.pageErrors };
    roleResult.confirmationRequired = confirmationRequired;
    console.log(`    signup: ${confirmationRequired ? 'EMAIL CONFIRMATION REQUIRED (cannot log in)' : 'created + logged in'}`);
    if (bucket.pageErrors.length) console.log(`    signup pageErrors: ${JSON.stringify(bucket.pageErrors)}`);
    if (bucket.consoleErrors.length) console.log(`    signup consoleErrors: ${JSON.stringify(bucket.consoleErrors)}`);
    // Close signup page; we'll re-enter cleanly via login next.
    await ctx.pages().forEach(p => p.close().catch(() => {}));
  } catch (e) {
    roleResult.signup = { error: e.message };
    console.log(`    signup FAILED: ${e.message.split('\n')[0]}`);
    results.push(roleResult);
    continue;
  }

  if (roleResult.confirmationRequired) {
    roleResult.note = 'Account created but email confirmation is ON — cannot log in to test flows. User must disable email confirmation in Supabase, or provide a way to read confirmation emails.';
    results.push(roleResult);
    continue;
  }

  // 2) Log in fresh
  const { page, bucket: loginBucket } = await login(ctx, acct.email);
  roleResult.login = { consoleErrors: loginBucket.consoleErrors, pageErrors: loginBucket.pageErrors };
  console.log(`    login: ok (errors: ${loginBucket.pageErrors.length} page, ${loginBucket.consoleErrors.length} console)`);

  // 3) Visit role routes, capture screenshots + errors
  for (const route of acct.routes) {
    const b = { consoleErrors: [], pageErrors: [], failedReqs: [] };
    const handlers = [
      page.on('console', m => { if (m.type() === 'error') b.consoleErrors.push(m.text().slice(0, 200)); }),
      page.on('pageerror', e => b.pageErrors.push(e.message.slice(0, 200))),
      page.on('requestfailed', r => { const u=r.url(); if(u.includes('/api/')||u.startsWith(BASE)) b.failedReqs.push(r.url().replace(BASE,'')+' '+r.failure()?.errorText); }),
    ];
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(2500);
      const body = (await page.evaluate(() => document.body.innerText)).slice(0, 250).replace(/\s+/g,' ').trim();
      const safeName = acct.type + '-' + route.replace(/^\/?#?\/?/, '').replace(/[/:]/g, '_') + (route === '/' ? 'home' : '');
      await page.screenshot({ path: path.join(SHOT_DIR, `${safeName || acct.type+'-home'}.png`), fullPage: true }).catch(()=>{});
      roleResult.pages.push({ route, preview: body, consoleErrors: b.consoleErrors, pageErrors: b.pageErrors, failedReqs: b.failedReqs });
      console.log(`    [${route.padEnd(22)}] ok  errs=${b.pageErrors.length}/${b.consoleErrors.length}  preview: ${body.slice(0,80)}`);
    } catch (e) {
      roleResult.pages.push({ route, error: e.message.slice(0,200) });
      console.log(`    [${route.padEnd(22)}] ERROR: ${e.message.split('\n')[0].slice(0,100)}`);
    }
  }

  // 4) Auth-gating check: forbidden routes should NOT show business content
  for (const route of acct.forbidden) {
    try {
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 15000 });
      // The admin guard resolves its role over the network first. Sampling
      // during "Checking access…" reads as ungated and reports a false alarm.
      for (let i = 0; i < 20; i++) {
        const t = await page.evaluate(() => document.body.innerText);
        if (!/Checking access/i.test(t)) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1500);
      // Test the WHOLE body: the sidebar nav alone fills the first ~250 chars,
      // so slicing before matching hid every real gate message.
      const body = await page.evaluate(() => document.body.innerText);
      const gated = /Access Denied|Admin Access|not authoris|not authoriz|Forbidden|don't have|Sign in to|account required|⛔|🔒/i.test(body);
      const preview = body.replace(/\s+/g, ' ');
      // Show the gate message itself, not the nav chrome that precedes it.
      const at = preview.search(/⛔|🔒|Access Denied/);
      const snippet = preview.slice(at >= 0 ? at : 0, (at >= 0 ? at : 0) + 70);
      roleResult.gating.push({ route, gated, preview: preview.slice(0, 300) });
      console.log(`    gate [${route.padEnd(18)}] ${gated ? 'GATED ✓' : 'NOT GATED ⚠'}  preview: ${snippet}`);
    } catch (e) {
      roleResult.gating.push({ route, error: e.message.slice(0,150) });
    }
  }

  // Sign out for a clean next iteration
  try {
    const signoutBtn = page.locator('button:has-text("Sign out"), button:has-text("Sign Out")').first();
    if (await signoutBtn.count()) { await signoutBtn.click(); await page.waitForTimeout(1500); }
    else {
      // Fallback: clear storage via Supabase directly
      await page.evaluate(() => { try { localStorage.clear(); sessionStorage.clear(); } catch{} });
      await page.goto(`${BASE}/#/auth/login`, { waitUntil: 'networkidle' }).catch(()=>{});
      await page.waitForTimeout(800);
    }
  } catch {}
  await ctx.pages().forEach(p => p.close().catch(() => {}));

  results.push(roleResult);
}

await browser.close();
fs.writeFileSync(path.resolve('role-report.json'), JSON.stringify(results, null, 2));

// Summary
console.log('\n=== ROLE TEST SUMMARY ===');
console.log(`Accounts created: ${results.length}`);
for (const r of results) {
  const pgErr = r.pages.reduce((a,p)=>a+(p.pageErrors?.length||0),0);
  const cnErr = r.pages.reduce((a,p)=>a+(p.consoleErrors?.length||0),0);
  const gated = r.gating.filter(g=>g.gated).length + '/' + r.gating.length;
  console.log(`  ${r.label.padEnd(10)} ${r.confirmationRequired ? '(confirmation needed)' : ''} pages:${r.pages.length} pageErr:${pgErr} consoleErr:${cnErr} gating:${gated}`);
}
console.log(`\nScreenshots: ${SHOT_DIR}`);
console.log(`Full report:  role-report.json`);
