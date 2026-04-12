import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { dispatchLeadDelivery } from './services/leadDelivery.js';
import { createLogger, maskPII } from './utils/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.LEADS_DB_PATH || path.join(__dirname, '..', 'data', 'leads.db');
const WORKER_INTERVAL_MS = Number(process.env.LEAD_WORKER_INTERVAL_MS || 7000);
const MAX_ATTEMPTS = Number(process.env.LEAD_DELIVERY_MAX_ATTEMPTS || 5);

function envBool(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function parseTrustProxy(value) {
  if (value == null || value === '') return false;
  const normalized = String(value).trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (/^\d+$/.test(normalized)) return Number(normalized);
  return value;
}

const NODE_ENV = process.env.NODE_ENV || 'development';
const TRUST_PROXY = parseTrustProxy(process.env.TRUST_PROXY);
const CORS_ALLOWLIST = (process.env.CORS_ALLOWLIST || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const CAPTCHA_PROVIDER = (process.env.CAPTCHA_PROVIDER || '').trim().toLowerCase();
const CAPTCHA_SECRET = (process.env.CAPTCHA_SECRET || '').trim();
const CAPTCHA_VERIFY_URL = (process.env.CAPTCHA_VERIFY_URL || '').trim();
const CAPTCHA_TOKEN_FIELD = (process.env.CAPTCHA_TOKEN_FIELD || 'captcha_token').trim();
const CAPTCHA_FAIL_OPEN = envBool('CAPTCHA_FAIL_OPEN', false);
const CAPTCHA_REQUIRED_IN_PROD = envBool('CAPTCHA_REQUIRED_IN_PROD', true);
const CAPTCHA_MIN_SCORE = Number(process.env.CAPTCHA_MIN_SCORE || 0);

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);

const LEAD_SCHEMA_VERSION = '1.0';
const IDEMPOTENCY_BUCKET_MINUTES = Number(process.env.LEAD_IDEMPOTENCY_BUCKET_MINUTES || 10);
const CONTRACT_KEYS = ['name', 'email', 'phone', 'company', 'message', 'product', 'utm', 'source_url', 'lang', 'schema_version', 'idempotency_key'];
const CAPS = { name: 120, email: 190, phone: 40, company: 120, message: 4000, product: 200, utm: 1000, source_url: 500, lang: 12, schema_version: 16, idempotency_key: 128 };
const LEAD_STATUS = { NEW: 'new', DELIVERED: 'delivered', FAILED: 'failed', PROCESSED: 'processed' };
const QUEUE_STATUS = { PENDING: 'pending', PROCESSING: 'processing', DELIVERED: 'delivered', FAILED: 'failed', PROCESSED: 'processed' };
const logger = createLogger({ service: 'lead-api' });

db.exec(`CREATE TABLE IF NOT EXISTS leads (
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
  user_agent TEXT,
  idempotency_key TEXT,
  dedup_fingerprint TEXT,
  dedup_bucket TEXT
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC)`);

db.exec(`CREATE TABLE IF NOT EXISTS lead_delivery_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_error TEXT,
  external_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_queue_due ON lead_delivery_queue(status, next_attempt_at)`);

db.exec(`CREATE TABLE IF NOT EXISTS lead_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  request_id TEXT,
  FOREIGN KEY (lead_id) REFERENCES leads(id)
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_lead_events_lead_id ON lead_events(lead_id, created_at DESC)`);

function ensureColumn(tableName, columnName, columnDefinition) {
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!cols.some((c) => c.name === columnName)) db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
}
ensureColumn('leads', 'utm', 'TEXT');
ensureColumn('leads', 'schema_version', `TEXT NOT NULL DEFAULT '${LEAD_SCHEMA_VERSION}'`);
ensureColumn('leads', 'status', `TEXT NOT NULL DEFAULT '${LEAD_STATUS.NEW}'`);
ensureColumn('leads', 'external_id', 'TEXT');
ensureColumn('leads', 'idempotency_key', 'TEXT');
ensureColumn('leads', 'dedup_fingerprint', 'TEXT');
ensureColumn('leads', 'dedup_bucket', 'TEXT');
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_idempotency_key_unique ON leads(idempotency_key) WHERE idempotency_key IS NOT NULL AND idempotency_key <> ''`);
db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_dedup_fingerprint_unique ON leads(dedup_fingerprint) WHERE dedup_fingerprint IS NOT NULL AND dedup_fingerprint <> ''`);
ensureColumn('lead_delivery_queue', 'status', `TEXT NOT NULL DEFAULT '${QUEUE_STATUS.PENDING}'`);
ensureColumn('lead_delivery_queue', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('lead_delivery_queue', 'next_attempt_at', "TEXT NOT NULL DEFAULT (datetime('now'))");
ensureColumn('lead_delivery_queue', 'last_error', 'TEXT');
ensureColumn('lead_delivery_queue', 'external_id', 'TEXT');
ensureColumn('lead_delivery_queue', 'created_at', "TEXT NOT NULL DEFAULT (datetime('now'))");
ensureColumn('lead_delivery_queue', 'updated_at', "TEXT NOT NULL DEFAULT (datetime('now'))");
ensureColumn('lead_events', 'request_id', 'TEXT');
db.exec(`CREATE INDEX IF NOT EXISTS idx_lead_events_request_id ON lead_events(request_id)`);

const app = express();
app.set('trust proxy', TRUST_PROXY);
app.use(express.json({ limit: '32kb' }));

const DEV_ORIGIN_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (CORS_ALLOWLIST.includes(origin)) return true;
  if (NODE_ENV !== 'production' && DEV_ORIGIN_PATTERN.test(origin)) return true;
  return false;
}

app.use('/api', (req, res, next) => {
  const origin = req.headers.origin?.toString();
  if (origin && !isAllowedOrigin(origin)) {
    if (req.method === 'OPTIONS') return res.status(403).end();
    return res.status(403).json({ ok: false, error: 'cors_forbidden', message: 'Origin not allowed' });
  }

  if (origin && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID, X-Correlation-ID, Idempotency-Key');
  if (req.method === 'OPTIONS') return res.status(204).end();
  return next();
});

app.use((req, res, next) => {
  const requestId = req.headers['x-request-id']?.toString().trim() || randomUUID();
  const correlationId = req.headers['x-correlation-id']?.toString().trim() || requestId;
  req.requestId = requestId;
  req.correlationId = correlationId;
  req.log = logger.child({ request_id: requestId, correlation_id: correlationId, route: req.path, method: req.method });
  res.setHeader('x-request-id', requestId);
  res.setHeader('x-correlation-id', correlationId);
  next();
});

function clientIp(req) {
  return req.ip || req.headers['x-forwarded-for']?.toString().split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

function captchaConfigured() {
  return Boolean(CAPTCHA_SECRET && (CAPTCHA_VERIFY_URL || CAPTCHA_PROVIDER));
}

function resolveCaptchaVerifyUrl() {
  if (CAPTCHA_VERIFY_URL) return CAPTCHA_VERIFY_URL;
  if (CAPTCHA_PROVIDER === 'turnstile') return 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  if (CAPTCHA_PROVIDER === 'recaptcha') return 'https://www.google.com/recaptcha/api/siteverify';
  if (CAPTCHA_PROVIDER === 'hcaptcha') return 'https://hcaptcha.com/siteverify';
  return '';
}

async function verifyCaptchaToken({ token, ip }) {
  const verifyUrl = resolveCaptchaVerifyUrl();
  if (!verifyUrl || !CAPTCHA_SECRET) return { ok: false, reason: 'captcha_not_configured' };
  if (!token) return { ok: false, reason: 'captcha_token_missing' };

  const payload = new URLSearchParams({ secret: CAPTCHA_SECRET, response: token, remoteip: ip || '' });
  const response = await fetch(verifyUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: payload,
  });

  if (!response.ok) return { ok: false, reason: `captcha_verify_http_${response.status}` };

  const data = await response.json();
  if (data?.success !== true) return { ok: false, reason: 'captcha_failed', detail: data };
  if (CAPTCHA_MIN_SCORE > 0 && typeof data.score === 'number' && data.score < CAPTCHA_MIN_SCORE) {
    return { ok: false, reason: 'captcha_score_too_low', detail: data };
  }
  return { ok: true, detail: data };
}

const hits = new Map();
function rateLimit(req, res, next) {
  const ip = clientIp(req);
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((ts) => now - ts < 60_000);
  if (list.length >= 5) {
    req.log?.warn('rate_limit_rejected', { ip, window_hits: list.length + 1 });
    return res.status(429).json({ ok: false, error: 'rate_limited', message: 'Too many requests. Please try again in a minute.', request_id: req.requestId });
  }
  list.push(now);
  hits.set(ip, list);
  next();
}

function sanitizeString(v) { return typeof v === 'string' ? v.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim() : ''; }
function normalize(payload = {}) {
  const out = {};
  for (const k of CONTRACT_KEYS) out[k] = sanitizeString(payload[k]);
  out.email = out.email.toLowerCase();
  out.lang = out.lang.toLowerCase();
  out.schema_version = out.schema_version || LEAD_SCHEMA_VERSION;
  if (out.phone) out.phone = out.phone.replace(/\s+/g, ' ').trim();
  return out;
}

function resolveIdempotencyKey(req, normalizedPayload) {
  const headerKey = sanitizeString(req.headers['idempotency-key']);
  return headerKey || normalizedPayload.idempotency_key || '';
}

function buildDedupFingerprint(value, bucketStartIso) {
  const parts = [
    bucketStartIso,
    value.name,
    value.email,
    value.phone,
    value.company,
    value.product,
    value.message,
    value.source_url,
  ];
  return createHash('sha256').update(parts.join('\u001f')).digest('hex');
}

function getBucketStartIso(at = Date.now()) {
  const bucketMs = Math.max(1, IDEMPOTENCY_BUCKET_MINUTES) * 60 * 1000;
  const bucketStart = Math.floor(at / bucketMs) * bucketMs;
  return new Date(bucketStart).toISOString();
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
  for (const [key, max] of Object.entries(CAPS)) if (v[key] && v[key].length > max) errors[key] = `Too long (max ${max})`;
  return errors;
}

function addLeadEvent({ leadId = null, eventType, payload = {}, requestId = null }) {
  try {
    db.prepare(`INSERT INTO lead_events (lead_id, event_type, payload_json, created_at, request_id) VALUES (?, ?, ?, ?, ?)`).run(
      leadId ?? 0,
      eventType,
      JSON.stringify(payload),
      new Date().toISOString(),
      requestId,
    );
  } catch (err) {
    logger.warn('lead_event_insert_skipped', { event_type: eventType, request_id: requestId, error: err });
  }
}

const insertLead = db.prepare(`
  INSERT INTO leads (created_at, name, email, phone, company, product, message, utm, lang, source_url, schema_version, status, ip, user_agent, idempotency_key, dedup_fingerprint, dedup_bucket)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
const insertQueueItem = db.prepare(`
  INSERT INTO lead_delivery_queue (lead_id, status, attempts, next_attempt_at, created_at, updated_at)
  VALUES (?, ?, 0, ?, ?, ?)
`);
const findLeadByIdempotencyKey = db.prepare(`
  SELECT id, schema_version, status FROM leads WHERE idempotency_key = ? ORDER BY id ASC LIMIT 1
`);
const findLeadByDedupFingerprint = db.prepare(`
  SELECT id, schema_version, status FROM leads WHERE dedup_fingerprint = ? ORDER BY id ASC LIMIT 1
`);

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'lead-api' }));

app.post('/api/lead', rateLimit, async (req, res) => {
  try {
    const value = normalize(req.body);
    req.log.info('lead_submit_received', { payload: value });
    const errors = validate(value);
    if (Object.keys(errors).length) {
      addLeadEvent({ eventType: 'validation_failed', payload: { errors }, requestId: req.requestId });
      req.log.warn('lead_validation_failed', { errors, payload: value });
      return res.status(422).json({ ok: false, error: 'validation_failed', errors, request_id: req.requestId });
    }

    const ip = clientIp(req);
    const isProd = NODE_ENV === 'production';
    const captchaIsConfigured = captchaConfigured();
    const requiresCaptcha = captchaIsConfigured || (isProd && CAPTCHA_REQUIRED_IN_PROD);

    if (requiresCaptcha) {
      if (!captchaIsConfigured) {
        if (!CAPTCHA_FAIL_OPEN) {
          addLeadEvent({ eventType: 'captcha_not_configured', payload: { env: NODE_ENV }, requestId: req.requestId });
          req.log.error('captcha_not_configured', { env: NODE_ENV });
          return res.status(503).json({ ok: false, error: 'captcha_unavailable', request_id: req.requestId });
        }
        addLeadEvent({ eventType: 'captcha_skipped_fail_open', payload: { reason: 'not_configured', env: NODE_ENV }, requestId: req.requestId });
        req.log.warn('captcha_skipped_fail_open', { env: NODE_ENV });
      } else {
        const token = sanitizeString(req.body?.[CAPTCHA_TOKEN_FIELD]);
        const captcha = await verifyCaptchaToken({ token, ip });
        if (!captcha.ok) {
          addLeadEvent({ eventType: 'captcha_failed', payload: { reason: captcha.reason }, requestId: req.requestId });
          req.log.warn('captcha_failed', { reason: captcha.reason, detail: captcha.detail });
          if (!CAPTCHA_FAIL_OPEN) {
            return res.status(403).json({ ok: false, error: 'captcha_failed', request_id: req.requestId });
          }
        }
      }
    }

    const createdAt = new Date().toISOString();
    const userAgent = req.headers['user-agent'] || '';
    const idempotencyKey = resolveIdempotencyKey(req, value);
    const dedupBucket = idempotencyKey ? null : getBucketStartIso(Date.now());
    const dedupFingerprint = idempotencyKey ? null : buildDedupFingerprint(value, dedupBucket);

    try {
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
        idempotencyKey || null,
        dedupFingerprint || null,
        dedupBucket || null,
      );

      const leadId = Number(result.lastInsertRowid);
      insertQueueItem.run(leadId, QUEUE_STATUS.PENDING, createdAt, createdAt, createdAt);
      addLeadEvent({ leadId, eventType: 'created', payload: { schema_version: value.schema_version, idempotency_key_present: !!idempotencyKey }, requestId: req.requestId });
      addLeadEvent({ leadId, eventType: 'queued', payload: { status: QUEUE_STATUS.PENDING }, requestId: req.requestId });
      req.log.info('lead_created_and_queued', { lead_id: leadId, schema_version: value.schema_version, status: LEAD_STATUS.NEW, ip, user_agent: userAgent });

      return res.status(200).json({ ok: true, id: leadId, duplicate: false, schema_version: value.schema_version, status: LEAD_STATUS.NEW, request_id: req.requestId });
    } catch (insertErr) {
      const isUniqueConstraint = insertErr?.code === 'SQLITE_CONSTRAINT_UNIQUE' || String(insertErr?.message || '').includes('UNIQUE constraint failed');
      if (!isUniqueConstraint) throw insertErr;

      const existing = idempotencyKey
        ? findLeadByIdempotencyKey.get(idempotencyKey)
        : findLeadByDedupFingerprint.get(dedupFingerprint);

      if (!existing?.id) throw insertErr;

      addLeadEvent({
        leadId: Number(existing.id),
        eventType: 'dedup_hit',
        payload: {
          by: idempotencyKey ? 'idempotency_key' : 'fingerprint',
          idempotency_key_present: !!idempotencyKey,
          dedup_bucket: dedupBucket,
        },
        requestId: req.requestId,
      });
      req.log.info('lead_dedup_hit', {
        lead_id: Number(existing.id),
        by: idempotencyKey ? 'idempotency_key' : 'fingerprint',
        idempotency_key_present: !!idempotencyKey,
      });

      return res.status(200).json({
        ok: true,
        id: Number(existing.id),
        duplicate: true,
        schema_version: existing.schema_version || value.schema_version,
        status: existing.status || LEAD_STATUS.NEW,
        request_id: req.requestId,
      });
    }
  } catch (err) {
    req.log.error('lead_submit_failed', { error: err, payload: req.body ? maskPII(req.body) : undefined });
    return res.status(500).json({ ok: false, error: 'server_error', message: 'Internal server error', request_id: req.requestId });
  }
});

if (NODE_ENV !== 'production') {
  app.get('/api/leads', (_req, res) => {
    try {
      const rows = db.prepare(`
        SELECT l.id, l.created_at, l.name, l.email, l.phone, l.company, l.message, l.product, l.utm, l.source_url,
               l.lang, l.schema_version, l.status, l.external_id, l.idempotency_key, l.dedup_fingerprint, l.dedup_bucket,
               q.status AS delivery_status, q.attempts, q.last_error, q.next_attempt_at
        FROM leads l
        LEFT JOIN lead_delivery_queue q ON q.lead_id = l.id
        ORDER BY l.id DESC LIMIT 100
      `).all();
      return res.json({ ok: true, count: rows.length, leads: rows });
    } catch (err) {
      logger.error('get_leads_failed', { request_id: _req.requestId, correlation_id: _req.correlationId, error: err });
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
    const item = db.prepare(`
      SELECT q.id AS queue_id, q.lead_id, q.attempts,
             l.name, l.email, l.phone, l.company, l.message, l.product, l.utm, l.source_url, l.lang, l.schema_version,
             l.ip, l.user_agent, l.created_at
      FROM lead_delivery_queue q
      JOIN leads l ON l.id = q.lead_id
      WHERE q.status IN ('pending', 'failed') AND q.next_attempt_at <= ?
      ORDER BY q.next_attempt_at ASC, q.id ASC
      LIMIT 1
    `).get(new Date().toISOString());
    if (!item) return;

    const now = new Date().toISOString();
    const workerReqId = `worker-${randomUUID()}`;
    const workerLog = logger.child({ request_id: workerReqId, correlation_id: workerReqId, worker: 'lead_delivery', queue_id: item.queue_id, lead_id: item.lead_id });
    workerLog.info('worker_processing_started', { attempts_so_far: item.attempts, lead: item });

    db.prepare(`UPDATE lead_delivery_queue SET status='processing', updated_at=? WHERE id=?`).run(now, item.queue_id);
    addLeadEvent({ leadId: item.lead_id, eventType: 'processing_started', payload: { queue_id: item.queue_id }, requestId: workerReqId });

    const delivery = await dispatchLeadDelivery({
      id: item.lead_id, created_at: item.created_at, name: item.name, email: item.email, phone: item.phone, company: item.company,
      message: item.message, product: item.product, utm: item.utm, source_url: item.source_url, lang: item.lang, schema_version: item.schema_version,
      ip: item.ip, user_agent: item.user_agent, request_id: workerReqId, correlation_id: workerReqId,
    });

    const attempts = Number(item.attempts) + 1;
    const crmResult = delivery.results.find((r) => r.adapter === 'crm');
    const externalId = crmResult?.external_id || crmResult?.externalId || null;

    if (delivery.ok) {
      db.prepare(`UPDATE lead_delivery_queue SET status='delivered', attempts=?, last_error=NULL, external_id=COALESCE(?, external_id), updated_at=? WHERE id=?`).run(attempts, externalId, now, item.queue_id);
      db.prepare(`UPDATE leads SET status=?, external_id=COALESCE(?, external_id) WHERE id=?`).run(LEAD_STATUS.DELIVERED, externalId, item.lead_id);
      addLeadEvent({ leadId: item.lead_id, eventType: 'delivered_to_integrations', payload: { attempts, results: delivery.results }, requestId: workerReqId });
      workerLog.info('worker_delivery_success', { attempts, results: delivery.results, external_id: externalId });
    } else {
      const nextAttemptAt = nextBackoffIso(attempts);
      const errorText = delivery.results.filter((r) => r.status === 'failed').map((r) => `${r.adapter}: ${r.reason}`).join(' | ') || 'delivery_failed';
      const queueStatus = attempts >= MAX_ATTEMPTS ? QUEUE_STATUS.FAILED : QUEUE_STATUS.PENDING;
      db.prepare(`UPDATE lead_delivery_queue SET status=?, attempts=?, last_error=?, next_attempt_at=?, updated_at=? WHERE id=?`).run(queueStatus, attempts, maskPII(errorText).slice(0, 2000), nextAttemptAt, now, item.queue_id);
      db.prepare(`UPDATE leads SET status=? WHERE id=?`).run(LEAD_STATUS.FAILED, item.lead_id);
      addLeadEvent({ leadId: item.lead_id, eventType: attempts >= MAX_ATTEMPTS ? 'retry_exhausted' : 'retry_scheduled', payload: { attempts, next_attempt_at: nextAttemptAt, error: maskPII(errorText) }, requestId: workerReqId });
      workerLog.warn(attempts >= MAX_ATTEMPTS ? 'worker_retry_exhausted' : 'worker_retry_scheduled', {
        attempts,
        next_attempt_at: nextAttemptAt,
        queue_status: queueStatus,
        failed_results: delivery.results.filter((r) => r.status === 'failed'),
      });
    }
  } catch (error) {
    logger.error('delivery_worker_tick_failed', { request_id: 'worker-loop', correlation_id: 'worker-loop', error });
  } finally {
    workerBusy = false;
  }
}

setInterval(() => runDeliveryWorkerTick().catch((error) => logger.error('delivery_worker_crashed', { request_id: 'worker-loop', correlation_id: 'worker-loop', error })), WORKER_INTERVAL_MS);

app.listen(PORT, () => {
  logger.info('lead_api_started', {
    request_id: 'startup',
    correlation_id: 'startup',
    port: PORT,
    db_path: DB_PATH,
    worker_interval_ms: WORKER_INTERVAL_MS,
    trust_proxy: String(TRUST_PROXY),
    cors_allowlist: CORS_ALLOWLIST.length ? CORS_ALLOWLIST : ['dev localhost defaults only'],
    captcha_configured: captchaConfigured(),
    captcha_fail_open: CAPTCHA_FAIL_OPEN,
    captcha_required_in_prod: CAPTCHA_REQUIRED_IN_PROD,
  });
  if (NODE_ENV === 'production' && !TRUST_PROXY) {
    logger.warn('trust_proxy_disabled_in_production', { request_id: 'startup', correlation_id: 'startup' });
  }
});
