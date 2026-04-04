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
  STRIPE_WEBHOOK_SECRET,      // whsec_...
  STRIPE_MONTHLY_PRICE_ID,    // price_...
  STRIPE_ANNUAL_PRICE_ID,     // price_...
  GOOGLE_CLIENT_ID,           // your-client-id.apps.googleusercontent.com
  FRONTEND_URL,               // https://your-frontend.railway.app or file://
  PORT = 3000,
} = process.env;

if (!STRIPE_SECRET_KEY) {
  console.error('❌ STRIPE_SECRET_KEY is required. Set it in Railway environment variables.');
  process.exit(1);
}

const stripe       = Stripe(STRIPE_SECRET_KEY);
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ── SQLite database (persists on Railway volume) ───────────
// On Railway: add a Volume mounted at /data
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
// Put livermore-copilot.html inside lp-backend/public/
app.use(express.static(path.join(__dirname, 'public')));

// Root redirect → the HTML file
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'public', 'livermore-copilot.html');
  const fs = require('fs');
  if (fs.existsSync(htmlPath)) {
    res.sendFile(htmlPath);
  } else {
    res.json({
      status: 'ok',
      service: 'Livermore Co-Pilot Backend',
      time: new Date().toISOString(),
      note: 'Put livermore-copilot.html in the public/ folder to serve the frontend',
    });
  }
});

// ── CORS — allow your frontend domain ──────────────────────
const allowedOrigins = [
  FRONTEND_URL,
  'http://localhost:3000',
  'http://localhost:5500',
  'null',           // file:// origin
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (file://, Postman) or matching origins
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: not allowed — ' + origin));
  },
  credentials: true,
}));

// ── Raw body for Stripe webhook (must come before json parser) ──
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── Health check (API only) ────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'Livermore Co-Pilot Backend', time: new Date().toISOString() });
});

// ══════════════════════════════════════════════════════════
//  POST /api/pro-status
//  Called on every user login to check Stripe subscription
//  Body: { email, token }
//  Returns: { isPro, planName, renewsAt }
// ══════════════════════════════════════════════════════════
app.post('/api/pro-status', async (req, res) => {
  const { email, token } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });

  // Optionally verify Google token
  if (token && GOOGLE_CLIENT_ID && !token.startsWith('mock_')) {
    try {
      await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    } catch(e) {
      return res.status(401).json({ error: 'invalid token' });
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

  // Verify Google token
  if (token && GOOGLE_CLIENT_ID && !token.startsWith('mock_')) {
    try {
      await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    } catch(e) {
      return res.status(401).json({ error: 'invalid token' });
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
    try {
      await googleClient.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    } catch(e) { return res.status(401).json({ error: 'invalid token' }); }
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
