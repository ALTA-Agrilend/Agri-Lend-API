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

- `Functions/index.js` — single Cloud Function entrypoint (Express app with all endpoints + GEE logic inline)
- `Functions/package.json` — Node 18; deps: `@google/earthengine`, `express`, `cors`, `firebase-admin`, `firebase-functions`
- `Functions/gee-service-account-key.json` — service account key (gitignored, must exist locally); project `agri-lend`, email `gee-api@agri-lend.iam.gserviceaccount.com`
- `Functions/.env.example` — env variable reference (not loaded by the app; for documentation only)
- `GEE-helper-function.js` — standalone GEE helper module (not imported by `index.js`; code is duplicated inline)
- `GEE-script-original.js` — original Earth Engine Code Editor script (reference only)

## Architecture

- Single Firebase Cloud Function exported as `agriLendAPI` (`functions.https.onRequest(app)`)
- Express app with 7 routes: `POST /api/v1/farms/telemetry`, `/annual-peaks`, `/environment`, `/land-security`, `/ndvi`; `GET /api/v1/health`, `/api/v1/docs`
- All data routes accept `{ roiCoordinates: [[lon,lat], ...], farmId?: string }` in POST body
- GEE initialization is lazy/cached (singleton promise pattern) — `await initializeEarthEngine()` before any GEE call
- All POST endpoints return `{ success: bool, data?: {...}, error?: string, metadata?: {...} }`

## Quirks & gotchas

- **GEE helper code is duplicated** between `index.js` and `GEE-helper-function.js`. Changes must be kept in sync or the module should be imported instead.
- **`getInfo()` calls are synchronous** — the `Promise.all` wrapping in the telemetry endpoint does not provide real parallelism (each `getInfo()` blocks the event loop).
- **Hardcoded date ranges** (2021–2026) exist throughout both files — update when extending beyond 2026.
- **Hardcoded placeholder values** in GEE responses (not computed from satellite data): `extreme_events_metrics` (rain/ temp), `distance_to_reliable_water_km`.
- **Discrepancy**: `actual_season_evaluated: 2026` in environment response metadata vs `actualYear = 2025` used in rainfall/temperature computations.
- **`.firebaserc` is gitignored** — already tracked in repo, but new clones must recreate or un-ignore it for `firebase deploy` to know the project.
- **CI workflow** (`.github/workflows/deploy.yml`) is empty — no automated deploy.
- **`firebase-functions-test`** is in devDependencies but unused; no test infrastructure exists.
