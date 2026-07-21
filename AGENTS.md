# Agri-Lend Geospatial Telemetry API

## Commands (run from `Functions/`)

| Action | Command |
|--------|---------|
| Local dev server | `npm run serve` (runs `firebase emulators:start --only functions`) |
| Deploy | `npm run deploy` (runs `firebase deploy --only functions`) |
| View logs | `npm run logs` |
| Functions shell | `npm run shell` |

No test, lint, typecheck, or formatter scripts exist.

## Key files

- `Functions/index.js` — single Cloud Function (entrypoint, all endpoints + GEE logic in one file)
- `Functions/package.json` — Node 18; deps: `@google/earthengine`, `express`, `cors`, `firebase-admin`, `firebase-functions`
- `GEE-helper-function.js` — standalone refactored GEE helper module (not used by the function; code is duplicated inline in `index.js`)
- `GEE-script-original.js` — original Earth Engine Code Editor script (reference/prototype only)

## Architecture

- Single Firebase Cloud Function exported as `agriLendAPI` (`functions.https.onRequest(app)`)
- Express app with 7 routes:
  - `POST /api/v1/farms/telemetry` — all 4 data categories
  - `POST /api/v1/farms/annual-peaks` — NDVI peaks by year
  - `POST /api/v1/farms/environment` — rainfall & temperature
  - `POST /api/v1/farms/land-security` — soil & terrain
  - `POST /api/v1/farms/ndvi` — weekly NDVI timeline + crop type
  - `GET /api/v1/health` — health check
  - `GET /api/v1/docs` — endpoint listing
- All data routes accept `{ roiCoordinates: [[lon,lat], ...], farmId?: string }` in POST body
- GEE initialization is lazy and cached (singleton promise pattern) — `initializeEarthEngine()` must be awaited before any GEE call

## Quirks & gotchas

- Service account key lives at `Functions/gee-service-account-key.json` (gitignored) — project `agri-lend`, email `gee-api@agri-lend.iam.gserviceaccount.com`
- `.firebaserc` and `Firebase.json` are pre-configured for project `agri-lend` with emulators on ports 5001 (functions), 4000 (UI)
- The old root-level `GEE-ServiceAccount-Key.json` should be deleted (duplicate, gitignored)
- CI workflow (`.github/workflows/deploy.yml`) is empty — no automated deploy
- No tests exist; no test framework configured (`firebase-functions-test` is in devDependencies but unused)
- GEE helper code (`safeGet`, `buildMonthlyDict`, `getS2Collection`, etc.) is duplicated between `index.js` and `GEE-helper-function.js` — changes should be kept in sync or the module should be imported
- All POST endpoints return `{ success: bool, data?: {...}, error?: string, metadata?: {...} }`
- Hardcoded date ranges (2021–2026) exist throughout — update when extending beyond 2026
