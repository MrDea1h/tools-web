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
- `DB_PATH=./data/leads.db`

If `.env` is missing, backend still starts with those defaults.

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
  -d '{"name":"Test User","email":"test@example.com","message":"Hello from local test"}'
```

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
