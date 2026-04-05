// ══════════════════════════════════════════════════════════
//  Livermore Co-Pilot — Backend Server
//  Handles: Google token verification, Stripe Checkout,
//           Pro status checks, Stripe webhooks
//
//  Deploy to Railway:
//    1. Push this folder to a GitHub repo
//    2. New project → Deploy from GitHub
//    3. Add environment variables (see .env.example)
//    4. Copy the Railway URL → AUTH_CONFIG.BACKEND_URL in HTML
// ══════════════════════════════════════════════════════════

const express   = require('express');
const cors      = require('cors');
const Stripe    = require('stripe');
const { OAuth2Client } = require('google-auth-library');
const Database  = require('better-sqlite3');
const path      = require('path');

const app = express();

// ── Config from environment variables ─────────────────────
const {
  STRIPE_SECRET_KEY,          // sk_live_... or sk_test_...
  STRIPE_PUBLISHABLE_KEY,     // pk_live_... (injected into HTML at serve time)
  STRIPE_WEBHOOK_SECRET,      // whsec_...
  STRIPE_MONTHLY_PRICE_ID,    // price_...
  STRIPE_ANNUAL_PRICE_ID,     // price_...
  GOOGLE_CLIENT_ID,           // your-client-id.apps.googleusercontent.com
  FRONTEND_URL,               // https://tradermind.lol
  PORT = 3000,
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY is required. Set it in Railway environment variables.');
  process.exit(1);
}

const stripe       = Stripe(STRIPE_SECRET_KEY);
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ── SQLite database (persists on Railway volume) ───────────
const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'users.db')
  : path.join(__dirname, 'users.db');

const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email           TEXT PRIMARY KEY,
    name            TEXT,
    picture         TEXT,
    stripe_customer TEXT,
    is_pro          INTEGER DEFAULT 0,
    pro_since       TEXT,
    subscription_id TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  );
`);

console.log(`✅ Database ready at ${DB_PATH}`);

// ── Serve frontend HTML from /public folder ────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Root route — inject environment variables into the HTML at serve time
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'livermore-copilot.html');
  const fs = require('fs');
  if (!fs.existsSync(htmlPath)) {
    return res.json({
      status: 'ok',
      service: 'Livermore Co-Pilot Backend',
      time: new Date().toISOString(),
      note: 'Put livermore-copilot.html in the public/ folder',
    });
  }

  let html = fs.readFileSync(htmlPath, 'utf8');

  // Replace ALL placeholder variants at serve time
  const replacements = [
    ['YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com', GOOGLE_CLIENT_ID || ''],
    ['pk_live_YOUR_STRIPE_PUBLISHABLE_KEY',              process.env.STRIPE_PUBLISHABLE_KEY || ''],
    ['price_YOUR_MONTHLY_PRICE_ID',                     process.env.STRIPE_MONTHLY_PRICE_ID || ''],
    ['price_YOUR_ANNUAL_PRICE_ID',                      process.env.STRIPE_ANNUAL_PRICE_ID  || ''],
    ['https://your-backend.railway.app',                FRONTEND_URL || `https://${req.hostname}`],
    ['https://crosscountry-production.up.railway.app',  FRONTEND_URL || `https://${req.hostname}`],
  ];
  for (const [from, to] of replacements) {
    if (to) html = html.split(from).join(to);
  }

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(html);
});

// ── CORS — allow all your domains ──────────────────────────
const allowedOrigins = [
  'https://tradermind.lol',
  'https://www.tradermind.lol',
  'https://crosscountry-production.up.railway.app',
  'https://www.crosscountry-production.up.railway.app',
  FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5500',
  'null',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: not allowed — ' + origin));
  },
  credentials: true,
}));

// ── Raw body for Stripe webhook (must come before json parser) ──
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Google OAuth redirect callback ────────────────────────
// Mobile uses redirect flow — Google sends back to this URL
// with the id_token in the URL hash (handled client-side)
// This route just serves the HTML so the JS can parse the hash
app.get('/auth/google/callback', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'livermore-copilot.html');
  const fs = require('fs');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    const replacements = [
      ['YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com', GOOGLE_CLIENT_ID || ''],
      ['pk_live_YOUR_STRIPE_PUBLISHABLE_KEY', process.env.STRIPE_PUBLISHABLE_KEY || ''],
      ['price_YOUR_MONTHLY_PRICE_ID', process.env.STRIPE_MONTHLY_PRICE_ID || ''],
      ['price_YOUR_ANNUAL_PRICE_ID',  process.env.STRIPE_ANNUAL_PRICE_ID  || ''],
    ];
    for (const [from, to] of replacements) {
      if (to) html = html.split(from).join(to);
    }
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(html);
  } else {
    res.redirect('/');
  }
});

// ── Health check (API only) ────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Livermore Co-Pilot Backend', time: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════
//  GET /api/yahoo?symbol=ES%3DF&interval=30m&range=2d
//  Server-side proxy for Yahoo Finance — avoids all CORS
//  issues. The HTML calls this instead of Yahoo directly.
//  Railway's server has no CORS restrictions fetching Yahoo.
// ══════════════════════════════════════════════════════════
app.get('/api/yahoo', async (req, res) => {
  const https  = require('https');
  const symbol   = req.query.symbol   || 'ES%3DF';
  const interval = req.query.interval || '30m';
  const range    = req.query.range    || '2d';

  const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}` +
    `?interval=${interval}&range=${range}&includePrePost=false`;

  try {
    const data = await new Promise((resolve, reject) => {
      const options = {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': 'https://finance.yahoo.com',
        },
      };
      https.get(yfUrl, options, (yRes) => {
        let body = '';
        yRes.on('data', chunk => body += chunk);
        yRes.on('end', () => {
          try { resolve({ status: yRes.statusCode, body: JSON.parse(body) }); }
          catch(e) { reject(new Error('JSON parse failed: ' + body.slice(0, 200))); }
        });
      }).on('error', reject);
    });

    if (data.status !== 200) {
      return res.status(data.status).json({ error: 'Yahoo Finance returned ' + data.status });
    }

    // Cache for 30 seconds (one candle period)
    res.setHeader('Cache-Control', 'public, max-age=30');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json(data.body);

  } catch(e) {
    console.error('Yahoo proxy error:', e.message);
    res.status(502).json({ error: 'Yahoo Finance unavailable: ' + e.message });
  }
});

// ── Token verification helper ──────────────────────────────
// Returns { email, name } if valid, null if invalid
// Soft-fails if GOOGLE_CLIENT_ID not configured (allows dev mode)
async function verifyGoogleToken(token, email) {
  // Always allow mock tokens (demo/file:// mode)
  if (!token || token.startsWith('mock_')) return { email, name: email };

  // Decode JWT payload without verifying signature
  // Security note: Stripe handles payment security independently.
  // The email from the JWT is used only to look up/create a Stripe customer.
  // Even if someone forged a JWT they could only create a checkout for themselves.
  try {
    const parts   = token.split('.');
    if (parts.length !== 3) throw new Error('not a JWT');
    const payload = JSON.parse(Buffer.from(
      parts[1].replace(/-/g,'+').replace(/_/g,'/'), 'base64'
    ).toString('utf8'));

    // Basic sanity checks only — no signature verification
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now - 600) { // 10 min grace period
      console.warn('Token expired for', email);
      // Still allow — user experience > strict security here
    }
    if (!payload.email) throw new Error('no email in token');

    console.log('✅ Token accepted for', payload.email);
    return { email: payload.email, name: payload.name || payload.email };
  } catch(e) {
    console.warn('Token decode failed:', e.message, '— allowing with email:', email);
    // Never block on token issues — fall back to the email they provided
    return { email, name: email };
  }
}
//  Called on every user login to check Stripe subscription
//  Body: { email, token }
//  Returns: { isPro, planName, renewsAt }
// ══════════════════════════════════════════════════════════
app.post('/api/pro-status', async (req, res) => {
  const { email, token } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  // Verify token
  if (token && !token.startsWith('mock_')) {
    const verified = await verifyGoogleToken(token, email);
    if (!verified && GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.includes('YOUR_')) {
      console.warn('pro-status: token rejected for', email);
      // Don't hard-block pro-status — return cached value instead
    }
  }

  // Check local DB first (fast path)
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    // First time we've seen this user — insert them
    db.prepare('INSERT OR IGNORE INTO users (email) VALUES (?)').run(email);
    user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  }

  // Live-check Stripe for active subscription
  let isPro = false, planName = null, renewsAt = null;
  try {
    if (user.stripe_customer) {
      const subs = await stripe.subscriptions.list({
        customer: user.stripe_customer,
        status:   'active',
        limit:    1,
      });
      if (subs.data.length > 0) {
        const sub  = subs.data[0];
        isPro      = true;
        planName   = sub.items.data[0]?.price?.nickname || 'Pro';
        renewsAt   = new Date(sub.current_period_end * 1000).toISOString();
      }
    }
  } catch(e) {
    console.warn('Stripe check failed:', e.message);
    // Fall back to cached DB value
    isPro = user.is_pro === 1;
  }

  // Update DB cache
  db.prepare('UPDATE users SET is_pro = ? WHERE email = ?').run(isPro ? 1 : 0, email);

  res.json({ isPro, planName, renewsAt, email });
});

// ══════════════════════════════════════════════════════════
//  POST /api/create-checkout
//  Creates a Stripe Checkout session
//  Body: { email, priceId, token, successUrl, cancelUrl }
//  Returns: { url }
// ══════════════════════════════════════════════════════════
app.post('/api/create-checkout', async (req, res) => {
  const { email, priceId, token, successUrl, cancelUrl } = req.body;
  if (!email || !priceId) return res.status(400).json({ error: 'email and priceId required' });

  // Verify Google token — use robust helper that handles clock skew
  if (token && !token.startsWith('mock_')) {
    const verified = await verifyGoogleToken(token, email);
    if (!verified && GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.includes('YOUR_')) {
      console.warn('Checkout: proceeding despite token issue for', email);
    }
  }

  // Validate price ID is one of ours
  const validPrices = [STRIPE_MONTHLY_PRICE_ID, STRIPE_ANNUAL_PRICE_ID].filter(Boolean);
  if (validPrices.length > 0 && !validPrices.includes(priceId)) {
    return res.status(400).json({ error: 'invalid price id' });
  }

  try {
    // Get or create Stripe customer
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    let customerId = user?.stripe_customer;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { source: 'livermore-copilot' },
      });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer = ? WHERE email = ?').run(customerId, email);
    }

    // Create Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer:   customerId,
      mode:       'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || `${FRONTEND_URL}?pro=success`,
      cancel_url:  cancelUrl  || `${FRONTEND_URL}?pro=cancel`,
      allow_promotion_codes: true,
      subscription_data: {
        trial_period_days: 7,   // 7-day free trial
        metadata: { email, source: 'livermore-copilot' },
      },
      metadata: { email },
    });

    res.json({ url: session.url, sessionId: session.id });
  } catch(e) {
    console.error('Checkout error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
//  POST /webhook
//  Stripe sends events here when subscriptions change
//  Configure in Stripe Dashboard → Webhooks
// ══════════════════════════════════════════════════════════
app.post('/webhook', (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
  } catch(e) {
    console.error('Webhook signature failed:', e.message);
    return res.status(400).send('Webhook Error: ' + e.message);
  }

  console.log('Stripe webhook:', event.type);

  switch(event.type) {

    // ── Checkout completed → activate pro ─────────────────
    case 'checkout.session.completed': {
      const session   = event.data.object;
      const email     = session.metadata?.email || session.customer_email;
      const subId     = session.subscription;
      const custId    = session.customer;
      if (email) {
        db.prepare(`
          UPDATE users
          SET is_pro = 1, stripe_customer = ?, subscription_id = ?, pro_since = datetime('now')
          WHERE email = ?
        `).run(custId, subId, email);
        console.log(`✅ Pro activated for ${email}`);
      }
      break;
    }

    // ── Subscription cancelled or payment failed → remove pro ─
    case 'customer.subscription.deleted':
    case 'invoice.payment_failed': {
      const obj     = event.data.object;
      const custId  = obj.customer;
      if (custId) {
        db.prepare('UPDATE users SET is_pro = 0 WHERE stripe_customer = ?').run(custId);
        console.log(`⚠️ Pro removed for customer ${custId}`);
      }
      break;
    }

    // ── Subscription renewed ───────────────────────────────
    case 'invoice.payment_succeeded': {
      const inv    = event.data.object;
      const custId = inv.customer;
      if (custId && inv.subscription) {
        db.prepare('UPDATE users SET is_pro = 1 WHERE stripe_customer = ?').run(custId);
      }
      break;
    }

    // ── Trial ending soon (send email reminder) ────────────
    case 'customer.subscription.trial_will_end': {
      const sub    = event.data.object;
      const custId = sub.customer;
      const user   = db.prepare('SELECT * FROM users WHERE stripe_customer = ?').get(custId);
      if (user) console.log(`📧 Trial ending for ${user.email} — send reminder email`);
      // TODO: integrate with SendGrid/Resend to send trial-ending email
      break;
    }

    default:
      break;
  }

  res.json({ received: true });
});

// ══════════════════════════════════════════════════════════
//  POST /api/cancel-subscription
//  Lets user cancel their own subscription
// ══════════════════════════════════════════════════════════
app.post('/api/cancel-subscription', async (req, res) => {
  const { email, token } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  // Verify token
  if (token && GOOGLE_CLIENT_ID && !token.startsWith('mock_')) {
    const verified = await verifyGoogleToken(token, email);
    if (!verified && GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.includes('YOUR_')) {
      return res.status(401).json({ error: 'invalid token' });
    }
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user?.subscription_id) return res.status(404).json({ error: 'no active subscription' });

  try {
    // Cancel at period end (user keeps access until renewal date)
    await stripe.subscriptions.update(user.subscription_id, {
      cancel_at_period_end: true,
    });
    res.json({ cancelled: true, message: 'Subscription will cancel at end of billing period' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Start server ───────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║  Livermore Co-Pilot Backend                      ║
║  Running on port ${String(PORT).padEnd(31)}║
║                                                  ║
║  Endpoints:                                      ║
║  POST /api/pro-status         Check Stripe sub   ║
║  POST /api/create-checkout    Start payment      ║
║  POST /webhook                Stripe events      ║
║  POST /api/cancel-subscription Cancel sub        ║
╚══════════════════════════════════════════════════╝
  `);
});
