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

Optional integration envs:
- `CRM_WEBHOOK_URL` - if set, lead payload is POSTed to this CRM webhook.
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_TO` - reserved for email adapter wiring. Current scaffold is intentionally a no-op.
- `NOTIFIER_WEBHOOK_URL` - optional fallback notification hook, called when an adapter reports a delivery failure.

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

## Build check
```bash
npx vite build
```

---

## Production hardening notes
Before deploying this lead endpoint to production, add:

- **HTTPS everywhere**
  - Terminate TLS at your edge/proxy and force HTTPS.
- **Strict CORS policy**
  - Allow only known origins and methods.
- **Captcha / bot protection**
  - Add Turnstile/reCAPTCHA/hCaptcha on lead submission.
- **Environment secret management**
  - Do not commit secrets; use secure secret stores.
- **Database backup/restore plan**
  - Scheduled backups, retention policy, restore drills.
- **Centralized logging + alerting**
  - Structured logs, request IDs, error alerts, basic SLO monitoring.


## Validation notes (current)
- Required: `name`, `email`
- Optional: `phone`, `company`, `message`, `product`, `utm`, `source_url`, `lang`, `schema_version`
- Email is format-validated server-side.
- Phone is soft-validated (supports common human-entered formats).
- Strings are sanitized/normalized and capped per field.

## Lifecycle + async delivery queue
- Lead lifecycle in core table: `new -> delivered | failed -> processed` (future-ready `processed`).
- On `POST /api/lead`, API **only stores + enqueues** (no direct CRM call in HTTP request).
- Background worker (interval-based) picks due items from `lead_delivery_queue` and runs integrations via `server/services/leadDelivery.js`.
- Worker retries failed deliveries with exponential backoff and capped attempts (`LEAD_DELIVERY_MAX_ATTEMPTS`).
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
