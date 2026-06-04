'use strict';

/**
 * Printful dashboard browser automation.
 *
 * Creates products the same way a human would — through Printful's Design Lab.
 * This produces properly-synced Shopify products identical to ones created manually.
 *
 * Two-design approach per product:
 *   Light colors (Athletic Heather, White, Soft Cream, Heather Dust) → BLK design (black ink on light shirt)
 *   Dark colors  (Black Heather, Dark Grey Heather, Midnight Navy, Forest) → WHT design (white ink on dark shirt)
 *
 * Selectors use text/role/label strategies (not CSS classes) so they survive
 * routine Printful UI refreshes. When a selector breaks, screenshots in
 * /tmp/printful-screenshots/ show exactly where it failed.
 */

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs   = require('fs');
const path = require('path');
const https = require('https');
const http  = require('http');
const os   = require('os');

chromium.use(StealthPlugin());

const SHOPIFY_STORE  = process.env.PRINTFUL_SHOPIFY_STORE || '11ef7d-73.myshopify.com';
const SESSION_FILE   = path.join(os.tmpdir(), 'printful-session.json');
const SCREENSHOT_DIR = path.join(os.tmpdir(), 'printful-screenshots');
const STEP_MS        = 45_000;  // per-step timeout

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ─── Utilities ────────────────────────────────────────────────────────────────

function log(msg) {
  console.log(`[printful] ${new Date().toISOString()}  ${msg}`);
}

async function shot(page, label) {
  try {
    const p = path.join(SCREENSHOT_DIR, `${Date.now()}-${label}.png`);
    await page.screenshot({ path: p, fullPage: false });
    log(`📷  ${label}`);
  } catch (_) {}
}

async function screenshotBase64(page) {
  try { return (await page.screenshot()).toString('base64'); } catch (_) { return null; }
}

// Download a URL to a local temp file, following redirects
function downloadFile(url, filename) {
  const dest = path.join(os.tmpdir(), filename);
  return new Promise((resolve, reject) => {
    function get(u) {
      const mod = u.startsWith('https') ? https : http;
      mod.get(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303) {
          return get(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} fetching ${u}`));
        }
        const ws = fs.createWriteStream(dest);
        res.pipe(ws);
        ws.on('finish', () => { ws.close(); resolve(dest); });
        ws.on('error', reject);
      }).on('error', reject);
    }
    get(url);
  });
}

// ─── Session management ───────────────────────────────────────────────────────

async function loadSession(context) {
  if (!fs.existsSync(SESSION_FILE)) return;
  try {
    const cookies = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    await context.addCookies(cookies);
    log('Session loaded from disk');
  } catch (e) {
    log(`Session load warning: ${e.message}`);
  }
}

async function saveSession(context) {
  const cookies = await context.cookies();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(cookies, null, 2));
  log('Session saved to disk');
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

async function isLoggedIn(page) {
  try {
    await page.goto('https://www.printful.com/dashboard', {
      waitUntil: 'domcontentloaded', timeout: STEP_MS
    });
    const loggedIn = !page.url().includes('/login') && !page.url().includes('/signup');
    log(loggedIn ? 'Already logged in' : 'Not logged in — need to authenticate');
    return loggedIn;
  } catch (e) {
    log(`isLoggedIn check failed: ${e.message}`);
    return false;
  }
}

async function login(page, context) {
  log('Logging in to Printful...');
  await page.goto('https://www.printful.com/login', { waitUntil: 'networkidle', timeout: STEP_MS });
  await shot(page, '01-login-page');

  // Printful may show social login buttons first — click "Continue with email" to reveal the form
  const emailOptionSelectors = [
    'button:has-text("Continue with email")',
    'button:has-text("Sign in with email")',
    'button:has-text("Use email")',
    'button:has-text("Email")',
    'a:has-text("Continue with email")',
    'a:has-text("Sign in with email")',
    '[data-testid*="email"]:not(input)',
    '[data-provider="email"]',
  ];
  for (const sel of emailOptionSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 1500 })) {
        log(`Clicking email option: ${sel}`);
        await el.click();
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
        break;
      }
    } catch (_) {}
  }
  await shot(page, '01b-after-email-click');
  log(`Page URL after email-click: ${page.url()}`);

  // Fill email — broad selector set covering label, type, name, placeholder, autocomplete
  const emailField = page.locator([
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[id*="email" i]',
    'input[placeholder*="email" i]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
  ].join(', ')).first();
  await emailField.waitFor({ state: 'visible', timeout: STEP_MS });
  await emailField.fill(process.env.PRINTFUL_EMAIL);

  // Password — try label first, then type selector
  try {
    await page.getByLabel(/password/i).fill(process.env.PRINTFUL_PASSWORD);
  } catch (_) {
    await page.locator('input[type="password"]').first().fill(process.env.PRINTFUL_PASSWORD);
  }
  await shot(page, '02-login-filled');

  // Submit — try "Log in", "Sign in", "Continue"
  const submitBtn = page.getByRole('button', { name: /log in|sign in|continue/i }).first();
  await submitBtn.click();

  // Wait up to 45s for redirect — covers slow reCAPTCHA scoring
  await page.waitForURL(/\/dashboard/, { timeout: 45_000 });
  await shot(page, '03-post-login');
  await saveSession(context);
  log('Login successful');
}

// ─── Store navigation ─────────────────────────────────────────────────────────

async function dismissModals(page) {
  const dismissable = [
    '[data-testid="close-button"]',
    'button[aria-label="Close"]',
    'button[aria-label="Dismiss"]',
    '.modal__close',
    '[class*="close-btn"]',
  ];
  for (const sel of dismissable) {
    try {
      if (await page.locator(sel).first().isVisible({ timeout: 800 })) {
        await page.locator(sel).first().click();
        log(`Dismissed: ${sel}`);
      }
    } catch (_) {}
  }
}

async function findStoreUrl(page) {
  log('Locating Neurowyld store in Printful dashboard...');
  await shot(page, '04-dashboard');

  // If URL already contains a store ID, we're done
  const urlMatch = page.url().match(/\/stores\/(\d+)/);
  if (urlMatch) {
    log(`Store ID from URL: ${urlMatch[1]}`);
    return `https://www.printful.com/dashboard/stores/${urlMatch[1]}`;
  }

  const storeSlug = SHOPIFY_STORE.replace('.myshopify.com', '');

  // Try: store switcher dropdown in the header/sidebar
  try {
    const switcher = page.locator('[data-testid="store-switcher"], [class*="store-switcher"], [class*="StoreSwitcher"]').first();
    if (await switcher.isVisible({ timeout: 3000 })) {
      await switcher.click();
      await page.waitForTimeout(600);
      const option = page.locator(`text="${SHOPIFY_STORE}"`).or(page.locator(`text="${storeSlug}"`)).first();
      if (await option.isVisible({ timeout: 3000 })) {
        await option.click();
        await page.waitForLoadState('networkidle');
      }
    }
  } catch (_) {}

  // Try: sidebar link matching "neurowyld" or the shopify domain
  try {
    const links = await page.locator('a[href*="/dashboard/stores/"]').all();
    for (const link of links) {
      const text = (await link.innerText().catch(() => '')).toLowerCase();
      const href = await link.getAttribute('href').catch(() => '');
      if (text.includes('neurowyld') || text.includes(storeSlug) || href.includes('shopify')) {
        await link.click();
        await page.waitForLoadState('networkidle');
        log(`Navigated via store link: ${text}`);
        break;
      }
    }
  } catch (_) {}

  await shot(page, '05-store-navigated');

  const finalMatch = page.url().match(/\/stores\/(\d+)/);
  if (!finalMatch) {
    const err = new Error('Could not locate Neurowyld store. Check screenshots in /tmp/printful-screenshots/');
    err.screenshotBase64 = await screenshotBase64(page);
    throw err;
  }
  log(`Store ID: ${finalMatch[1]}`);
  return `https://www.printful.com/dashboard/stores/${finalMatch[1]}`;
}

// ─── Product catalog ──────────────────────────────────────────────────────────

async function openAddProduct(page, storeUrl) {
  log('Navigating to Add Product...');
  const productsUrl = storeUrl.replace(/\/$/, '') + '/products';
  await page.goto(productsUrl, { waitUntil: 'networkidle', timeout: STEP_MS });
  await shot(page, '06-products-page');

  const addBtn = page.getByRole('button', { name: /add product/i })
    .or(page.getByRole('link', { name: /add product/i }))
    .first();

  await addBtn.click({ timeout: STEP_MS });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await shot(page, '07-catalog-open');
  log('Product catalog open');
}

async function selectBC3001(page) {
  log('Selecting Bella+Canvas 3001...');

  // Search the catalog
  try {
    const box = page.getByPlaceholder(/search/i).or(page.getByRole('searchbox')).first();
    if (await box.isVisible({ timeout: 4000 })) {
      await box.fill('Bella Canvas 3001');
      await page.waitForTimeout(1200);
      await shot(page, '08-catalog-search');
    }
  } catch (_) {
    log('Search box not found — browsing catalog');
  }

  // Click the product tile
  const tile = page.locator('text=/Bella.*Canvas.*3001/i')
    .or(page.locator('[data-product-id="71"]'))
    .or(page.getByText('3001 Unisex Jersey Short Sleeve Tee'))
    .first();

  await tile.click({ timeout: STEP_MS });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await shot(page, '09-bc3001-selected');

  // Advance to Design Lab if there's a CTA button
  try {
    const cta = page.getByRole('button', { name: /start creating|create product|customize|get started/i }).first();
    if (await cta.isVisible({ timeout: 5000 })) {
      await cta.click();
      await page.waitForLoadState('networkidle');
    }
  } catch (_) {
    log('No explicit CTA — may have auto-entered Design Lab');
  }

  await page.waitForTimeout(3000); // Design Lab is a heavy SPA
  await shot(page, '10-design-lab-loaded');
  log('Design Lab ready');
}

// ─── Design Lab — upload & colour configuration ───────────────────────────────

async function triggerFileUpload(page, localPath) {
  log(`Uploading ${path.basename(localPath)}...`);

  // Strategy A: intercept the browser file-chooser event
  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 8000 }),
      (async () => {
        // Try buttons/areas that might open a file picker
        const triggers = [
          page.getByRole('button', { name: /upload/i }).first(),
          page.locator('[data-testid*="upload"]').first(),
          page.locator('[class*="upload-btn"]').first(),
          page.locator('[class*="design-upload"]').first(),
          page.locator('[class*="add-layer"]').first(),
          page.locator('[class*="canvas-area"]').first(),
        ];
        for (const t of triggers) {
          try {
            if (await t.isVisible({ timeout: 1500 })) { await t.click(); return; }
          } catch (_) {}
        }
        // Last resort: click the centre of the mockup canvas
        const canvas = page.locator('[class*="mockup"], [class*="canvas"], [class*="preview"]').first();
        await canvas.click({ timeout: 5000 });
      })()
    ]);
    await chooser.setFiles(localPath);
    log('File set via file-chooser event');
  } catch (_) {
    // Strategy B: directly set the hidden <input type="file">
    log('File-chooser timeout — falling back to direct input...');
    const input = page.locator('input[type="file"]').first();
    await input.setInputFiles(localPath);
    log('File set via direct <input type="file">');
  }

  // Wait for the upload + render cycle to settle
  await page.waitForLoadState('networkidle', { timeout: 30_000 });
  await page.waitForTimeout(2000);
}

async function selectColorSwatches(page, colorNames) {
  log(`Selecting colours: ${colorNames.join(', ')}`);
  for (const name of colorNames) {
    try {
      // Printful colour swatches have title / aria-label / data attribute with the colour name
      const swatch = page.getByTitle(name)
        .or(page.locator(`[aria-label="${name}"]`))
        .or(page.locator(`[data-color-name="${name}"]`))
        .or(page.locator(`[title="${name}"]`))
        .first();
      await swatch.click({ timeout: 4000 });
      await page.waitForTimeout(250);
    } catch (_) {
      log(`⚠️  Could not click swatch for: ${name}`);
    }
  }
  await shot(page, `colours-selected`);
}

async function configureDesigns(page, { blkFile, whtFile, lightColors, darkColors }) {
  log('Configuring designs per colour group...');
  await shot(page, '11-design-lab-start');

  const allColors = [...lightColors, ...darkColors];

  // ── Step 1: Select ALL desired colours ──────────────────────────────────
  await selectColorSwatches(page, allColors);

  // ── Step 2: Upload BLK design for light-coloured shirts ─────────────────
  if (lightColors.length > 0 && blkFile) {
    if (darkColors.length > 0) {
      // Focus on just the light colours before uploading so Printful
      // knows which variants this design is for
      log('Focusing light colours for BLK design...');
      await selectColorSwatches(page, lightColors);
    }
    await triggerFileUpload(page, blkFile);
    await shot(page, '12-blk-uploaded');
  }

  // ── Step 3: Upload WHT design for dark-coloured shirts ───────────────────
  if (darkColors.length > 0 && whtFile) {
    log('Focusing dark colours for WHT design...');
    await selectColorSwatches(page, darkColors);
    await triggerFileUpload(page, whtFile);
    await shot(page, '13-wht-uploaded');
  }

  log('Design configuration complete');
}

// ─── Wizard step-through ──────────────────────────────────────────────────────

async function advanceThroughWizard(page, productTitle) {
  log(`Advancing through wizard to product details. Title: "${productTitle}"`);
  const continueBtn = () => page.getByRole('button', { name: /continue|next|proceed/i }).first();

  // Click Continue up to 4 times — each click advances one wizard step
  for (let step = 1; step <= 4; step++) {
    await shot(page, `14-wizard-step-${step}`);

    // Check if we're already on the details/name page
    const nameInput = page.getByLabel(/product name|name|title/i)
      .or(page.locator('input[name="name"], input[placeholder*="name"]'))
      .first();
    if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      log(`On product details at step ${step}`);
      await fillProductTitle(page, nameInput, productTitle);
      break;
    }

    // Skip mockup selection if present — just continue with defaults
    try {
      await continueBtn().click({ timeout: 8000 });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1500);
    } catch (_) {
      log(`No Continue button at step ${step} — stopping advance`);
      break;
    }
  }

  await shot(page, '15-details-page');
}

async function fillProductTitle(page, nameInput, title) {
  try {
    await nameInput.triple_click ? nameInput.tripleClick() : nameInput.click({ clickCount: 3 });
  } catch (_) {
    await nameInput.click();
  }
  await nameInput.fill(title);
  log(`Title filled: ${title}`);
}

// ─── Submit to Shopify store ──────────────────────────────────────────────────

async function submitToStore(page) {
  log('Submitting product to Shopify store...');
  await shot(page, '16-pre-submit');

  const submitBtn = page.getByRole('button', {
    name: /submit to store|add to store|sync to store|publish|save product/i
  }).first();

  await submitBtn.click({ timeout: STEP_MS });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);
  await shot(page, '17-post-submit');
  log('Product submitted');
}

// ─── Extract Printful product ID from post-creation URL ───────────────────────

async function extractPrintfulId(page) {
  await page.waitForTimeout(2000);
  const url = page.url();
  await shot(page, '18-final-url');
  log(`Post-creation URL: ${url}`);

  // URL pattern after creation: .../products/{id} or .../product/{id}
  const m = url.match(/\/products?\/(\d+)/);
  if (m) {
    log(`Printful product ID: ${m[1]}`);
    return parseInt(m[1], 10);
  }

  // Fallback: look for a product-ID in the page body
  try {
    const idEl = page.locator('[data-product-id], [data-sync-id]').first();
    const id   = await idEl.getAttribute('data-product-id') || await idEl.getAttribute('data-sync-id');
    if (id) { log(`Printful product ID (DOM): ${id}`); return parseInt(id, 10); }
  } catch (_) {}

  // Last resort: look for any 6-8 digit number in a heading or breadcrumb
  try {
    const text = await page.locator('h1, h2, [class*="product-id"]').first().innerText();
    const num  = text.match(/\d{5,}/);
    if (num) { log(`Printful product ID (text): ${num[0]}`); return parseInt(num[0], 10); }
  } catch (_) {}

  const err = new Error(`Could not parse Printful product ID. URL: ${url}`);
  err.screenshotBase64 = await screenshotBase64(page);
  throw err;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

async function createProduct({ title, blkUrl, whtUrl, activeColors }) {
  log(`========================================`);
  log(`Creating: "${title}"`);
  log(`Light colours: ${activeColors.filter(c => c.type === 'light').map(c => c.color).join(', ') || 'none'}`);
  log(`Dark colours : ${activeColors.filter(c => c.type === 'dark').map(c => c.color).join(', ') || 'none'}`);
  log(`========================================`);

  const lightColors = activeColors.filter(c => c.type === 'light').map(c => c.color);
  const darkColors  = activeColors.filter(c => c.type === 'dark').map(c => c.color);
  const productTitle = title.endsWith('T-Shirt') ? title : `${title} T-Shirt`;

  // Download design files to temp files before opening browser
  let blkFile = null;
  let whtFile = null;
  try {
    if (lightColors.length > 0 && blkUrl) {
      log('Downloading BLK design file...');
      blkFile = await downloadFile(blkUrl, `blk_${Date.now()}.png`);
      log(`BLK saved: ${blkFile}`);
    }
    if (darkColors.length > 0 && whtUrl) {
      log('Downloading WHT design file...');
      whtFile = await downloadFile(whtUrl, `wht_${Date.now()}.png`);
      log(`WHT saved: ${whtFile}`);
    }
  } catch (e) {
    throw Object.assign(new Error(`Failed to download design file: ${e.message}`), { screenshotBase64: null });
  }

  const headless = process.env.DEBUG !== 'true';
  const browser = await chromium.launch({
    headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();

  // Log every console error from the page
  page.on('console', msg => { if (msg.type() === 'error') log(`PAGE ERROR: ${msg.text()}`); });

  try {
    // 1. Auth
    await loadSession(context);
    if (!(await isLoggedIn(page))) {
      await login(page, context);
    }
    await dismissModals(page);

    // 2. Find the Neurowyld store
    const storeUrl = await findStoreUrl(page);

    // 3. Open product catalog → select BC3001 → enter Design Lab
    await openAddProduct(page, storeUrl);
    await selectBC3001(page);

    // 4. Upload designs per colour group
    await configureDesigns(page, { blkFile, whtFile, lightColors, darkColors });

    // 5. Advance wizard, fill product title
    await advanceThroughWizard(page, productTitle);

    // 6. Submit to Shopify
    await submitToStore(page);

    // 7. Get Printful product ID
    const printfulProductId = await extractPrintfulId(page);

    log(`✅  Done! Printful product ID: ${printfulProductId}`);
    return { success: true, printful_product_id: printfulProductId, shopify_product_id: null };

  } catch (err) {
    log(`❌  Error: ${err.message}`);
    const b64 = err.screenshotBase64 || await screenshotBase64(page);
    const error = new Error(err.message);
    error.screenshotBase64 = b64;
    throw error;

  } finally {
    await browser.close().catch(() => {});
    // Clean up temp files
    if (blkFile) fs.unlink(blkFile, () => {});
    if (whtFile) fs.unlink(whtFile, () => {});
  }
}

module.exports = { createProduct };
