# tools-web local development

## Prerequisites
- Node.js 20+ (or current LTS)
- npm

## 1) Install dependencies
```bash
npm install
```

## 2) Configure local backend env
Copy the example env and adjust only if needed:
```bash
cp .env.example .env
```

Defaults are safe for local development:
- `PORT=8787`
- `LEADS_DB_PATH=./data/leads.db`
- `LEAD_WORKER_INTERVAL_MS=7000`
- `LEAD_DELIVERY_MAX_ATTEMPTS=5`
- `LEAD_PROCESSING_STALE_MS=300000`

Optional integration envs:
- `CRM_WEBHOOK_URL` - if set, lead payload is POSTed to this CRM webhook.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_TO` - reserved for email adapter wiring. Current scaffold is intentionally a no-op.
- `NOTIFIER_WEBHOOK_URL` - optional fallback notification hook, called when an adapter reports a delivery failure.

Security envs (Track 3 baseline):
- `TRUST_PROXY` - optional (`true/false`). Enable in production when running behind reverse proxies/load balancers so Express uses forwarded headers safely.
- `CORS_ALLOWLIST` - comma-separated origin allowlist for `/api/*`. In local dev, if empty, localhost origins are allowed by default.
- `CAPTCHA_PROVIDER` - optional: `turnstile`, `recaptcha`, or `hcaptcha`.
- `CAPTCHA_VERIFY_URL` - optional override for provider verify endpoint.
- `CAPTCHA_SECRET` - shared secret for captcha verification.
- `CAPTCHA_TOKEN_FIELD` - request body field for token (default: `captcha_token`).
- `CAPTCHA_FAIL_OPEN` - if `true`, allows lead submission when captcha verification errors/fails.
- `CAPTCHA_REQUIRED_IN_PROD` - if `true` (default), production requires captcha (or blocks when not configured and fail-open is false).
- `CAPTCHA_MIN_SCORE` - optional numeric threshold for score-based providers.

Backend reads `.env` automatically via `dotenv`. If `.env` is missing, backend still starts with local defaults and skips optional adapters.

## 3) Run backend (API)
In terminal A:
```bash
npm run server
```
Backend listens on `http://localhost:8787` by default.

Health check:
```bash
curl http://localhost:8787/api/health
```

## 4) Run frontend (Vite)
In terminal B:
```bash
npm run dev
```
Frontend runs on Vite dev server (usually `http://localhost:5173`).

Vite is configured to proxy all `/api/*` requests to `http://localhost:8787` during local development.

## 5) Test the form flow locally
1. Open the frontend in browser.
2. Submit the lead form from the UI.
3. Confirm API returns success in browser network tab (`/api/lead`).
4. Confirm data is written to SQLite file at `./data/leads.db`.

Optional quick API test:
```bash
curl -X POST http://localhost:8787/api/lead \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test User","email":"test@example.com","message":"Hello from local test","schema_version":"1.0"}'
```

## Lead API JSON contract (v1.0)
`POST /api/lead` accepts these keys:
- `name` (required)
- `email` (required)
- `phone` (optional, soft-validated)
- `company` (optional)
- `message` (optional)
- `product` (optional)
- `utm` (optional)
- `source_url` (optional)
- `lang` (optional)
- `schema_version` (optional; defaults to `"1.0"` if omitted)
- `idempotency_key` (optional; client-provided dedup key)

Optional request header:
- `Idempotency-Key` (optional; takes precedence over payload `idempotency_key`)
- `captcha_token` (optional by default; required when captcha enforcement is enabled in env)

Example payload:
```json
{
  "name": "Jane Doe",
  "email": "jane@example.com",
  "phone": "+46 70 123 45 67",
  "company": "Example AB",
  "message": "Please contact me",
  "product": "Linen set",
  "utm": "utm_source=google&utm_medium=cpc&utm_campaign=spring",
  "source_url": "https://example.com/#contact",
  "lang": "en",
  "schema_version": "1.0"
}
```

Lifecycle note:
- Backend trims/sanitizes text fields, enforces per-field max length, validates required fields (`name`, `email`) and email format, and performs soft phone validation.
- `schema_version` is persisted with each lead. If not sent, backend stores `"1.0"` and returns it in API response.
- Idempotency/dedup behavior:
  - If `Idempotency-Key` header (or payload `idempotency_key`) is provided, duplicate submits return HTTP 200 with the existing lead `id` and `duplicate: true`.
  - If no key is provided, backend computes a deterministic fingerprint from normalized fields (`name,email,phone,company,product,message,source_url`) plus a short time bucket (default 10 minutes) to absorb accidental double-click duplicates.
  - Duplicate submits do **not** enqueue a second delivery job.
  - Dedup hits are recorded in `lead_events` with event type `dedup_hit`. 

## Logging / PII
- Backend logs are structured JSON lines via `server/utils/logger.js` with levels: `debug`, `info`, `warn`, `error`.
- Log level is controlled by `LOG_LEVEL` (default: `info`).
- API and worker logs include both `request_id` and `correlation_id` for traceability.
- PII-safe masking is applied before emission:
  - email: masked local/domain fragments
  - phone: masked digits + length hint
  - IP: partially masked
  - message/body/text: snippet + length (no full text dump)
- Key events are logged with masked payloads: lead submit, validation failures, dedup hits, queue start, adapter delivery result, retries scheduled/exhausted, notifier outcomes.
- Error logs avoid raw full payload dumps and emit masked/summarized context only.

## Build check
```bash
npx vite build
```

---

## Production hardening notes
Baseline controls now included in backend:

- **CORS allowlist on `/api/*`**
  - Controlled via `CORS_ALLOWLIST` (comma-separated origins).
  - Dev-safe fallback: localhost origins are accepted when allowlist is empty.
- **Optional captcha verification on `POST /api/lead`**
  - Supports Turnstile/reCAPTCHA/hCaptcha via env.
  - In dev: if captcha is not configured, request continues.
  - In prod: behavior is controlled by `CAPTCHA_REQUIRED_IN_PROD` + `CAPTCHA_FAIL_OPEN`.
- **Proxy awareness**
  - `TRUST_PROXY` is optional and should be enabled when behind reverse proxies/load balancers.

Still required before production launch:

- **HTTPS everywhere**
  - Terminate TLS at your edge/proxy and force HTTPS.
- **Environment secret management**
  - Do not commit secrets; use secure secret stores.
- **Database backup/restore plan**
  - Scheduled backups, retention policy, restore drills.
- **Centralized logging + alerting**
  - Structured logs, request IDs, error alerts, basic SLO monitoring.


## Validation notes (current)
- Required: `name`, `email`
- Optional: `phone`, `company`, `message`, `product`, `utm`, `source_url`, `lang`, `schema_version`, `idempotency_key`
- Email is format-validated server-side.
- Phone is soft-validated (supports common human-entered formats).
- Strings are sanitized/normalized and capped per field.

## Lifecycle + async delivery queue
- Lead lifecycle in core table: `new -> delivered | failed -> processed` (future-ready `processed`).
- On `POST /api/lead`, API **only stores + enqueues** (no direct CRM call in HTTP request).
- Background worker (interval-based) picks due items from `lead_delivery_queue` and runs integrations via `server/services/leadDelivery.js`.
- Worker retries failed deliveries with exponential backoff and capped attempts (`LEAD_DELIVERY_MAX_ATTEMPTS`).
- Delivery is considered successful only if at least one adapter returns `sent` (`skipped` alone is not success).
- Worker auto-recovers stale `processing` items older than `LEAD_PROCESSING_STALE_MS` by re-queueing them to `pending`.
- `lead_events` stores audit events (`created`, `queued`, `processing_started`, `delivered_to_integrations`, `retry_scheduled`, `retry_exhausted`, `validation_failed`) with `request_id`.

## Lead delivery integrations scaffold
- Adapters live in `server/integrations/*` (`crmAdapter`, `emailAdapter`).
- Adapter activation is env-driven; missing config => `skipped` with reason.
- `crmAdapter` uses `CRM_WEBHOOK_URL`.
- `emailAdapter` is scaffold/no-op until SMTP sender is wired.
- On adapter failure, fallback notifier hook can call `NOTIFIER_WEBHOOK_URL`.

## Local dev inspection endpoint
When `NODE_ENV` is not `production`, backend exposes:

```bash
curl http://localhost:8787/api/leads
```

Returns latest 100 saved leads for quick local checks.
