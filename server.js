require('dotenv').config();

const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Database = require('better-sqlite3');
const OpenAI = require('openai');
const Stripe = require('stripe');

const app = express();
const db = new Database('mental-ai.sqlite');

// User/subscription data. Existing databases are upgraded safely on startup.
db.exec(`
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    plan TEXT DEFAULT 'free',
    lifetime INTEGER DEFAULT 0,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    subscription_status TEXT,
    current_period_end INTEGER
  )
`);

for (const statement of [
  'ALTER TABLE users ADD COLUMN stripe_customer_id TEXT',
  'ALTER TABLE users ADD COLUMN stripe_subscription_id TEXT',
  'ALTER TABLE users ADD COLUMN subscription_status TEXT',
  'ALTER TABLE users ADD COLUMN current_period_end INTEGER'
]) {
  try { db.exec(statement); } catch (_) { /* column already exists */ }
}

const JWT = process.env.JWT_SECRET;
if (!JWT || JWT.length < 32) {
  console.error('JWT_SECRET precisa existir e ter pelo menos 32 caracteres.');
  process.exit(1);
}

const ai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-5.6-luna';
const PREMIUM_CODE = process.env.PREMIUM_CODE || '';

const prices = {
  monthly: process.env.STRIPE_PRICE_MONTHLY,
  annual: process.env.STRIPE_PRICE_ANNUAL,
  quarterly: process.env.STRIPE_PRICE_QUARTERLY
};

function token(u) {
  return jwt.sign({ id: u.id, email: u.email }, JWT, { expiresIn: '30d' });
}

function auth(req, res, next) {
  try {
    const raw = req.headers.authorization || '';
    if (!raw.startsWith('Bearer ')) throw new Error('missing token');
    req.user = jwt.verify(raw.slice(7), JWT);
    next();
  } catch {
    res.status(401).json({ error: 'Faça login primeiro.' });
  }
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE id=?').get(id);
}

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    plan: u.plan,
    lifetime: Boolean(u.lifetime),
    subscriptionStatus: u.subscription_status || null,
    currentPeriodEnd: u.current_period_end || null
  };
}

function setSubscriptionByStripeSubscription(subscription) {
  const userId = subscription.metadata?.userId;
  if (!userId) return;

  const status = subscription.status;
  const active = ['active', 'trialing'].includes(status);
  const periodEnd = subscription.current_period_end || null;

  db.prepare(`
    UPDATE users
    SET stripe_subscription_id=?, subscription_status=?, current_period_end=?,
        plan=CASE WHEN lifetime=1 THEN 'premium' WHEN ? THEN 'premium' ELSE 'free' END
    WHERE id=?
  `).run(subscription.id, status, periodEnd, active ? 1 : 0, Number(userId));
}

function clearSubscription(subscription) {
  const userId = subscription.metadata?.userId;
  if (!userId) return;
  db.prepare(`
    UPDATE users
    SET stripe_subscription_id=NULL, subscription_status=?, current_period_end=NULL,
        plan=CASE WHEN lifetime=1 THEN 'premium' ELSE 'free' END
    WHERE id=?
  `).run(subscription.status || 'canceled', Number(userId));
}

// Stripe webhook MUST receive the raw body before express.json().
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).send('Stripe webhook não configurado.');
  }

  let event;
  try {
    const signature = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook inválido:', err.message);
    return res.status(400).send('Webhook inválido.');
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        const userId = Number(session.metadata?.userId || 0);
        if (userId) {
          db.prepare(`UPDATE users SET stripe_customer_id=?, stripe_subscription_id=? WHERE id=?`)
            .run(session.customer || null, session.subscription || null, userId);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.resumed':
      case 'customer.subscription.paused':
      case 'customer.subscription.trial_will_end':
        setSubscriptionByStripeSubscription(event.data.object);
        break;
      case 'customer.subscription.deleted':
        clearSubscription(event.data.object);
        break;
      case 'invoice.paid': {
        const invoice = event.data.object;
        if (invoice.subscription && stripe) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          setSubscriptionByStripeSubscription(subscription);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        if (invoice.subscription && stripe) {
          const subscription = await stripe.subscriptions.retrieve(invoice.subscription);
          setSubscriptionByStripeSubscription(subscription);
        }
        break;
      }
      default:
        break;
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Erro processando webhook:', err);
    res.status(500).send('Erro interno.');
  }
});

app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/auth/signup', async (req, res) => {
  try {
    const e = String(req.body.email || '').trim().toLowerCase();
    const p = String(req.body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(e)) return res.status(400).json({ error: 'E-mail inválido.' });
    if (p.length < 8) return res.status(400).json({ error: 'Senha mínima: 8 caracteres.' });
    const h = await bcrypt.hash(p, 12);
    const r = db.prepare('INSERT INTO users(email,password_hash) VALUES(?,?)').run(e, h);
    res.json({ token: token({ id: r.lastInsertRowid, email: e }), message: 'Conta criada.' });
  } catch {
    res.status(400).json({ error: 'E-mail já cadastrado.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const e = String(req.body.email || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(e);
  if (!u || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) {
    return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  }
  res.json({ token: token(u), message: 'Login realizado.', user: publicUser(u) });
});

app.get('/api/me', auth, (req, res) => {
  const u = getUser(req.user.id);
  if (!u) return res.status(404).json({ error: 'Usuário não encontrado.' });
  res.json({ user: publicUser(u) });
});

const personas = {
  'Ayla Neri': 'acolhedora e empática',
  'Noa Valen': 'reflexiva e serena',
  'Mina Solis': 'suave e otimista',
  'Theo Arven': 'homem, firme e sereno',
  'Iris Vellum': 'articulada e calorosa'
};

app.post('/api/chat', auth, async (req, res) => {
  if (!ai) return res.status(503).json({ error: 'IA não configurada. Adicione OPENAI_API_KEY no .env.' });

  const character = String(req.body.character || 'Ayla Neri');
  const message = String(req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Digite uma mensagem.' });
  if (message.length > 8000) return res.status(400).json({ error: 'Mensagem muito longa.' });

  try {
    const r = await ai.responses.create({
      model: OPENAI_MODEL,
      instructions: `Você é ${character}, ${personas[character] || 'acolhedora'}. Responda em português natural e humano. Não afirme ser psicólogo, médico ou profissional humano. Não substitua atendimento profissional. Se houver risco imediato de autoagressão ou perigo, incentive a pessoa a procurar ajuda de emergência e alguém de confiança.`,
      input: message
    });
    res.json({ reply: r.output_text || 'Não consegui gerar uma resposta agora.' });
  } catch (err) {
    console.error('OpenAI:', err.message);
    res.status(500).json({ error: 'Erro ao conversar com a IA.' });
  }
});

app.post('/api/redeem', auth, (req, res) => {
  if (!PREMIUM_CODE || req.body.code !== PREMIUM_CODE) {
    return res.status(400).json({ error: 'Código inválido.' });
  }
  db.prepare("UPDATE users SET lifetime=1,plan='premium' WHERE id=?").run(req.user.id);
  res.json({ message: 'Premium vitalício ativado!' });
});

app.post('/api/checkout', auth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe não configurado.' });

  const plan = String(req.body.plan || '');
  const price = prices[plan];
  if (!price) return res.status(400).json({ error: 'Plano inválido ou sem Price ID configurado.' });

  const user = getUser(req.user.id);
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (user.lifetime) return res.status(400).json({ error: 'Sua conta já possui Premium vitalício.' });

  try {
    let customerId = user.stripe_customer_id;
    if (customerId) {
      try { await stripe.customers.retrieve(customerId); }
      catch { customerId = null; }
    }
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, metadata: { userId: String(user.id) } });
      customerId = customer.id;
      db.prepare('UPDATE users SET stripe_customer_id=? WHERE id=?').run(customerId, user.id);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price, quantity: 1 }],
      success_url: `${APP_URL}/?success=1`,
      cancel_url: `${APP_URL}/?cancel=1`,
      client_reference_id: String(user.id),
      metadata: { userId: String(user.id), plan },
      subscription_data: { metadata: { userId: String(user.id), plan } },
      allow_promotion_codes: true
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe checkout:', err.message);
    res.status(500).json({ error: 'Não foi possível iniciar a cobrança.' });
  }
});

app.post('/api/billing-portal', auth, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Stripe não configurado.' });
  const user = getUser(req.user.id);
  if (!user?.stripe_customer_id) return res.status(400).json({ error: 'Nenhuma assinatura Stripe encontrada.' });

  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripe_customer_id,
      return_url: APP_URL
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('Stripe portal:', err.message);
    res.status(500).json({ error: 'Não foi possível abrir o portal de cobrança.' });
  }
});

app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Mental AI rodando em ${APP_URL}`));
