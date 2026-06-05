'use strict';
require('dotenv').config();

const express = require('express');
const { createProduct } = require('./printful');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));

let busy = false;
const logBuffer = [];
const MAX_LOG = 500;
const origLog = console.log.bind(console);
const origErr = console.error.bind(console);
function captureLog(...args) {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logBuffer.push(`${new Date().toISOString()} ${line}`);
  if (logBuffer.length > MAX_LOG) logBuffer.shift();
  origLog(...args);
}
function captureErr(...args) {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  logBuffer.push(`${new Date().toISOString()} [ERR] ${line}`);
  if (logBuffer.length > MAX_LOG) logBuffer.shift();
  origErr(...args);
}
console.log = captureLog;
console.error = captureErr;

// ------------------------------------------------------------------
// Auth middleware
// ------------------------------------------------------------------
function requireAuth(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!process.env.BOT_SECRET) {
    console.error('[server] BOT_SECRET env var is not set');
    return res.status(500).json({ success: false, error: 'Server misconfigured' });
  }
  if (key !== process.env.BOT_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// ------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------

// Returns the most recent screenshot from the bot's run (for debugging login issues)
app.get('/screenshots/latest', requireAuth, (_req, res) => {
  const dir = require('path').join(require('os').tmpdir(), 'printful-screenshots');
  const fs = require('fs');
  if (!fs.existsSync(dir)) return res.json({ files: [] });
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.png'))
    .sort()
    .slice(-20)
    .map(f => {
      const data = fs.readFileSync(require('path').join(dir, f));
      return { name: f, base64: data.toString('base64') };
    });
  res.json({ files });
});

app.get('/logs', requireAuth, (_req, res) => {
  res.json({ lines: logBuffer.slice(-200) });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    busy,
    email: process.env.PRINTFUL_EMAIL || '(not set)',
    store: process.env.PRINTFUL_SHOPIFY_STORE || '(not set)',
    timestamp: new Date().toISOString()
  });
});

app.post('/create-product', requireAuth, async (req, res) => {
  if (busy) {
    return res.status(429).json({
      success: false,
      error: 'Bot is busy — another product is being created. Retry in a few minutes.'
    });
  }

  const { title, blk_url, wht_url, active_colors } = req.body;

  // Validate required fields
  if (!title) return res.status(400).json({ success: false, error: 'Missing field: title' });
  if (!Array.isArray(active_colors) || active_colors.length === 0) {
    return res.status(400).json({ success: false, error: 'Missing field: active_colors (array required)' });
  }

  const hasLight = active_colors.some(c => c.type === 'light');
  const hasDark  = active_colors.some(c => c.type === 'dark');
  if (hasLight && !blk_url) return res.status(400).json({ success: false, error: 'blk_url required for light colors' });
  if (hasDark  && !wht_url) return res.status(400).json({ success: false, error: 'wht_url required for dark colors' });

  busy = true;
  try {
    const result = await createProduct({ title, blkUrl: blk_url, whtUrl: wht_url, activeColors: active_colors });
    res.json(result);
  } catch (err) {
    console.error('[server] createProduct failed:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      screenshot_base64: err.screenshotBase64 || null
    });
  } finally {
    busy = false;
  }
});

app.listen(PORT, () => {
  console.log(`[server] Printful bot listening on port ${PORT}`);
  console.log(`[server] Printful email : ${process.env.PRINTFUL_EMAIL || '(not set)'}`);
  console.log(`[server] Shopify store  : ${process.env.PRINTFUL_SHOPIFY_STORE || '(not set)'}`);
  console.log(`[server] Debug mode     : ${process.env.DEBUG === 'true' ? 'ON (headed)' : 'OFF (headless)'}`);
});
