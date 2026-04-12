import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { dispatchLeadDelivery } from './services/leadDelivery.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.LEADS_DB_PATH || path.join(__dirname, '..', 'data', 'leads.db');
const WORKER_INTERVAL_MS = Number(process.env.LEAD_WORKER_INTERVAL_MS || 7000);
const MAX_ATTEMPTS = Number(process.env.LEAD_DELIVERY_MAX_ATTEMPTS || 5);

const LEAD_SCHEMA_VERSION = '1.0';
const CONTRACT_KEYS = ['name', 'email', 'phone', 'company', 'message', 'product', 'utm', 'source_url', 'lang', 'schema_version'];
const CAPS = { name: 120, email: 190, phone: 40, company: 120, message: 4000, product: 200, utm: 1000, source_url: 500, lang: 12, schema_version: 16 };

const LEAD_STATUS = { NEW: 'new', DELIVERED: 'delivered', FAILED: 'failed', PROCESSED: 'processed' };
const QUEUE_STATUS = { PENDING: 'pending', PROCESSING: 'processing', DELIVERED: 'delivered', FAILED: 'failed', PROCESSED: 'processed' };

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
    message TEXT,
    utm TEXT,
    lang TEXT,
    source_url TEXT,
    schema_version TEXT NOT NULL DEFAULT '1.0',
    status TEXT NOT NULL DEFAULT 'new',
    external_id TEXT,
    ip TEXT,
    user_agent TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS lead_delivery_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','delivered','failed','processed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    external_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS lead_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    event_type TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT NOT NULL,
    request_id TEXT,
    FOREIGN KEY (lead_id) REFERENCES leads(id)
  )
`);

function ensureColumn(tableName, columnName, columnDefinition) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!cols.some((c) => c.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

ensureColumn('leads', 'utm', 'TEXT');
ensureColumn('leads', 'schema_version', `TEXT NOT NULL DEFAULT '${LEAD_SCHEMA_VERSION}'`);
ensureColumn('leads', 'status', `TEXT NOT NULL DEFAULT '${LEAD_STATUS.NEW}'`);
ensureColumn('leads', 'external_id', 'TEXT');
ensureColumn('lead_delivery_queue', 'status', `TEXT NOT NULL DEFAULT '${QUEUE_STATUS.PENDING}'`);
ensureColumn('lead_delivery_queue', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('lead_delivery_queue', 'next_attempt_at', "TEXT NOT NULL DEFAULT (datetime('now'))");
ensureColumn('lead_delivery_queue', 'last_error', 'TEXT');
ensureColumn('lead_delivery_queue', 'external_id', 'TEXT');
ensureColumn('lead_delivery_queue', 'created_at', "TEXT NOT NULL DEFAULT (datetime('now'))");
ensureColumn('lead_delivery_queue', 'updated_at', "TEXT NOT NULL DEFAULT (datetime('now'))");
ensureColumn('lead_events', 'payload_json', 'TEXT');
ensureColumn('lead_events', 'request_id', 'TEXT');

db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_due ON lead_delivery_queue(status, next_attempt_at)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_lead_events_lead_id ON lead_events(lead_id, created_at DESC)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_lead_events_request_id ON lead_events(request_id)`);

const leadEventsLeadIdNotNull = db.prepare(`PRAGMA table_info(lead_events)`).all().some((c) => c.name === 'lead_id' && c.notnull === 1);

const app = express();
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  const requestId = req.headers['x-request-id']?.toString().trim() || randomUUID();
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);
  next();
});

const hits = new Map();
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((ts) => now - ts < 60_000);
  if (list.length >= 5) {
    return res.status(429).json({ ok: false, error: 'rate_limited', message: 'Too many requests. Please try again in a minute.' });
  }
  list.push(now);
  hits.set(ip, list);
  next();
}

function sanitizeString(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalize(payload = {}) {
  const out = {};
  for (const k of CONTRACT_KEYS) out[k] = sanitizeString(payload[k]);
  out.email = out.email.toLowerCase();
  out.lang = out.lang.toLowerCase();
  out.schema_version = out.schema_version || LEAD_SCHEMA_VERSION;
  return out;
}

function isSoftValidPhone(phone) {
  if (!phone) return true;
  const normalized = phone.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  return /^\+?[0-9]{6,20}$/.test(normalized) && /\d{6,}/.test(normalized);
}

function validate(v) {
  const errors = {};
  if (!v.name) errors.name = 'Name is required';
  if (!v.email) errors.email = 'Email is required';
  if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.email = 'Invalid email format';
  if (v.phone && !isSoftValidPhone(v.phone)) errors.phone = 'Invalid phone format';
  for (const [key, max] of Object.entries(CAPS)) {
    if (v[key] && v[key].length > max) errors[key] = `Too long (max ${max})`;
  }
  return errors;
}

function addLeadEvent({ leadId = null, eventType, payload = {}, requestId = null }) {
  const safeLeadId = leadId ?? (leadEventsLeadIdNotNull ? 0 : null);
  db.prepare(`INSERT INTO lead_events (lead_id, event_type, payload_json, created_at, request_id) VALUES (?, ?, ?, ?, ?)`)
    .run(safeLeadId, eventType, JSON.stringify(payload), new Date().toISOString(), requestId);
}

const insertLead = db.prepare(
  `INSERT INTO leads (created_at, name, email, phone, company, product, message, utm, lang, source_url, schema_version, status, ip, user_agent)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const insertQueueItem = db.prepare(
  `INSERT INTO lead_delivery_queue (lead_id, status, attempts, next_attempt_at, created_at, updated_at)
   VALUES (?, ?, 0, ?, ?, ?)`
);

const updateQueueReset = db.prepare(
  `UPDATE lead_delivery_queue
   SET status=?, attempts=0, next_attempt_at=?, last_error=NULL, updated_at=?
   WHERE lead_id=?`
);

function enqueueLead(leadId, nowIso) {
  const existing = db.prepare(`SELECT id FROM lead_delivery_queue WHERE lead_id=? ORDER BY id DESC LIMIT 1`).get(leadId);
  if (existing) {
    updateQueueReset.run(QUEUE_STATUS.PENDING, nowIso, nowIso, leadId);
    return;
  }
  insertQueueItem.run(leadId, QUEUE_STATUS.PENDING, nowIso, nowIso);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'lead-api' });
});

app.post('/api/lead', rateLimit, (req, res) => {
  const requestId = req.requestId;
  try {
    const value = normalize(req.body);
    const errors = validate(value);
    if (Object.keys(errors).length) {
      addLeadEvent({ eventType: 'validation_failed', payload: { errors }, requestId });
      return res.status(422).json({ ok: false, error: 'validation_failed', errors, request_id: requestId });
    }

    const createdAt = new Date().toISOString();
    const ip = req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || '';
    const userAgent = req.headers['user-agent'] || '';

    db.exec('BEGIN');
    const result = insertLead.run(
      createdAt,
      value.name,
      value.email,
      value.phone,
      value.company,
      value.product,
      value.message || '',
      value.utm,
      value.lang,
      value.source_url,
      value.schema_version,
      LEAD_STATUS.NEW,
      ip,
      userAgent,
    );

    const leadId = Number(result.lastInsertRowid);
    enqueueLead(leadId, createdAt);
    addLeadEvent({ leadId, eventType: 'created', payload: { schema_version: value.schema_version }, requestId });
    addLeadEvent({ leadId, eventType: 'queued', payload: { status: QUEUE_STATUS.PENDING }, requestId });
    db.exec('COMMIT');

    console.log(`[${requestId}] accepted lead ${leadId}`);
    return res.status(200).json({ ok: true, id: leadId, schema_version: value.schema_version, status: LEAD_STATUS.NEW, request_id: requestId });
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch {}
    console.error(`[${requestId}] POST /api/lead failed:`, err);
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Internal server error', request_id: requestId });
  }
});

if (process.env.NODE_ENV !== 'production') {
  app.get('/api/leads', (_req, res) => {
    try {
      const rows = db.prepare(
        `SELECT l.id, l.created_at, l.name, l.email, l.phone, l.company, l.message, l.product, l.utm, l.source_url,
                l.lang, l.schema_version, l.status, l.external_id,
                q.status AS delivery_status, q.attempts, q.last_error, q.next_attempt_at
         FROM leads l
         LEFT JOIN lead_delivery_queue q ON q.lead_id = l.id
         ORDER BY l.id DESC LIMIT 100`
      ).all();

      const deliverySummary = db.prepare(
        `SELECT status, COUNT(*) AS count
         FROM lead_delivery_queue
         GROUP BY status
         ORDER BY status`
      ).all();

      return res.json({ ok: true, count: rows.length, leads: rows, delivery_summary: deliverySummary });
    } catch (err) {
      console.error('GET /api/leads failed:', err);
      return res.status(500).json({ ok: false, error: 'server_error' });
    }
  });
}

let workerBusy = false;

function nextBackoffIso(attempts) {
  const seconds = Math.min(300, 10 * 2 ** Math.max(0, attempts - 1));
  return new Date(Date.now() + seconds * 1000).toISOString();
}

async function runDeliveryWorkerTick() {
  if (workerBusy) return;
  workerBusy = true;

  try {
    const item = db.prepare(
      `SELECT q.id AS queue_id, q.lead_id, q.attempts,
              l.name, l.email, l.phone, l.company, l.message, l.product, l.utm, l.source_url, l.lang, l.schema_version,
              l.ip, l.user_agent, l.created_at
       FROM lead_delivery_queue q
       JOIN leads l ON l.id = q.lead_id
       WHERE q.status IN ('pending', 'failed') AND q.next_attempt_at <= ?
       ORDER BY q.next_attempt_at ASC, q.id ASC
       LIMIT 1`
    ).get(new Date().toISOString());

    if (!item) return;

    const now = new Date().toISOString();
    const workerReqId = `worker-${randomUUID()}`;

    db.prepare(`UPDATE lead_delivery_queue SET status='processing', updated_at=? WHERE id=?`).run(now, item.queue_id);
    addLeadEvent({ leadId: item.lead_id, eventType: 'processing_started', payload: { queue_id: item.queue_id }, requestId: workerReqId });

    const delivery = await dispatchLeadDelivery({
      id: item.lead_id,
      created_at: item.created_at,
      name: item.name,
      email: item.email,
      phone: item.phone,
      company: item.company,
      message: item.message,
      product: item.product,
      utm: item.utm,
      source_url: item.source_url,
      lang: item.lang,
      schema_version: item.schema_version,
      ip: item.ip,
      user_agent: item.user_agent,
      request_id: workerReqId,
    });

    const attempts = Number(item.attempts) + 1;
    const crmResult = delivery.results.find((r) => r.adapter === 'crm');
    const externalId = crmResult?.external_id || null;

    if (delivery.ok) {
      db.prepare(
        `UPDATE lead_delivery_queue
         SET status='delivered', attempts=?, last_error=NULL, external_id=COALESCE(?, external_id), next_attempt_at=?, updated_at=?
         WHERE id=?`
      ).run(attempts, externalId, now, now, item.queue_id);

      db.prepare(`UPDATE leads SET status=?, external_id=COALESCE(?, external_id) WHERE id=?`).run(LEAD_STATUS.DELIVERED, externalId, item.lead_id);
      addLeadEvent({ leadId: item.lead_id, eventType: 'delivered_to_integrations', payload: { attempts, results: delivery.results }, requestId: workerReqId });
      console.log(`[${workerReqId}] delivered lead ${item.lead_id}`);
      return;
    }

    const nextAttemptAt = nextBackoffIso(attempts);
    const exhausted = attempts >= MAX_ATTEMPTS;
    const queueStatus = exhausted ? QUEUE_STATUS.FAILED : QUEUE_STATUS.PENDING;
    const errorText = delivery.results.filter((r) => r.status === 'failed').map((r) => `${r.adapter}: ${r.reason}`).join(' | ') || 'delivery_failed';

    db.prepare(
      `UPDATE lead_delivery_queue
       SET status=?, attempts=?, last_error=?, next_attempt_at=?, updated_at=?
       WHERE id=?`
    ).run(queueStatus, attempts, errorText.slice(0, 2000), nextAttemptAt, now, item.queue_id);

    db.prepare(`UPDATE leads SET status=? WHERE id=?`).run(LEAD_STATUS.FAILED, item.lead_id);
    addLeadEvent({
      leadId: item.lead_id,
      eventType: exhausted ? 'retry_exhausted' : 'retry_scheduled',
      payload: { attempts, next_attempt_at: nextAttemptAt, error: errorText },
      requestId: workerReqId,
    });
    console.error(`[${workerReqId}] delivery failed for lead ${item.lead_id}: ${errorText}`);
  } catch (error) {
    console.error('Delivery worker tick failed:', error);
  } finally {
    workerBusy = false;
  }
}

const timer = setInterval(() => {
  runDeliveryWorkerTick().catch((error) => console.error('Delivery worker crashed:', error));
}, WORKER_INTERVAL_MS);

timer.unref?.();

app.listen(PORT, () => {
  console.log(`Lead API listening on http://localhost:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Delivery worker interval: ${WORKER_INTERVAL_MS}ms`);
});
