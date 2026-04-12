import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { dispatchLeadDelivery } from './services/leadDelivery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.LEADS_DB_PATH || path.join(__dirname, '..', 'data', 'leads.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    company TEXT,
    product TEXT,
    message TEXT NOT NULL,
    lang TEXT,
    source_url TEXT,
    ip TEXT,
    user_agent TEXT,
    status TEXT NOT NULL DEFAULT 'new'
  )
`);

const app = express();
app.use(express.json({ limit: '32kb' }));

const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const windowMs = 60_000;
  const maxReq = 5;
  const list = (hits.get(ip) || []).filter((ts) => now - ts < windowMs);
  if (list.length >= maxReq) {
    return res.status(429).json({ ok: false, error: 'rate_limited', message: 'Too many requests. Please try again in a minute.' });
  }
  list.push(now);
  hits.set(ip, list);
  next();
}

function normalize(payload = {}) {
  const out = {};
  for (const k of ['name', 'email', 'phone', 'company', 'product', 'message', 'lang', 'source_url']) {
    const v = payload[k];
    out[k] = typeof v === 'string' ? v.trim() : '';
  }
  return out;
}

function validate(v) {
  const errors = {};
  if (!v.name) errors.name = 'Name is required';
  if (!v.email) errors.email = 'Email is required';
  if (!v.message) errors.message = 'Message is required';
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.email = 'Invalid email format';

  const caps = { name: 120, email: 190, phone: 40, company: 120, product: 200, message: 4000, lang: 8, source_url: 500 };
  for (const [key, max] of Object.entries(caps)) {
    if (v[key] && v[key].length > max) errors[key] = `Too long (max ${max})`;
  }
  return errors;
}

const insertLead = db.prepare(`
  INSERT INTO leads (created_at, name, email, phone, company, product, message, lang, source_url, ip, user_agent, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
`);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'lead-api' });
});

app.post('/api/lead', rateLimit, async (req, res) => {
  try {
    const value = normalize(req.body);
    const errors = validate(value);
    if (Object.keys(errors).length) {
      return res.status(422).json({ ok: false, error: 'validation_failed', errors });
    }

    const createdAt = new Date().toISOString();
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';
    const result = insertLead.run(
      createdAt,
      value.name,
      value.email,
      value.phone,
      value.company,
      value.product,
      value.message,
      value.lang,
      value.source_url,
      ip,
      userAgent,
    );

    const leadId = Number(result.lastInsertRowid);
    const delivery = await dispatchLeadDelivery({
      id: leadId,
      created_at: createdAt,
      ...value,
      ip,
      user_agent: userAgent,
    });

    return res.status(200).json({ ok: true, id: leadId, delivery });
  } catch (err) {
    console.error('POST /api/lead failed:', err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Lead API listening on http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});
