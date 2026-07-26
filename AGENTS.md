# Agri-Lend Geospatial Telemetry API

## Node.js version (deployed — working)

### Commands (run from `Functions/`)

| Action | Command |
|--------|---------|
| Local dev server | `npm run serve` (runs `firebase emulators:start --only functions`) |
| Deploy | `npm run deploy` (runs `firebase deploy --only functions`) |
| View logs | `npm run logs` |
| Functions shell | `npm run shell` |

## FastAPI/Python version (migration branch `fastapi-migration`)

### Commands (run from `FastAPI/`)

| Action | Command |
|--------|---------|
| Local dev | `uvicorn main:app --reload --port 5001` |
| Install deps | `pip install -r requirements.txt` |
| Render deploy | Push `fastapi-migration` branch; set root dir = `FastAPI` |

### Key files

- `FastAPI/main.py` — FastAPI app with all routes
- `FastAPI/gee_helper.py` — all GEE computation functions
- `FastAPI/requirements.txt` — Python deps (fastapi, uvicorn, earthengine-api)
- `FastAPI/gee-service-account-key.json` — gitignored; add via Render Secret File
- `FastAPI/render.yaml` — Render config reference

No test, lint, typecheck, or formatter scripts exist.

## Shared files

- `Docs/agri-lend-api.postman_collection.json` — Postman collection for both versions
- `Functions/gee-service-account-key.json` — service account key (gitignored, must exist locally); project `agri-lend`, email `gee-api@agri-lend.iam.gserviceaccount.com`
- `Functions/.env.example` — env variable reference (not loaded by the app; for documentation only)
- `GEE-helper-function.js` — standalone GEE helper module (not imported by `index.js`; code is duplicated inline)
- `GEE-script-original.js` — original Earth Engine Code Editor script (reference only)

## Architecture (both versions)

- 7 routes: `POST /api/v1/farms/telemetry`, `/annual-peaks`, `/environment`, `/land-security`, `/ndvi`; `GET /api/v1/health`, `/api/v1/docs`
- All data routes accept `{ roiCoordinates: [[lon,lat], ...], farmId?: string }` in POST body
- All POST endpoints return `{ success: bool, data?: {...}, error?: string, metadata?: {...} }`

## Quirks & gotchas (Node.js version)

- **GEE helper code is duplicated** between `index.js` and `GEE-helper-function.js`. Changes must be kept in sync or the module should be imported instead.
- **`getInfo()` calls are synchronous** — the `Promise.all` wrapping in the telemetry endpoint does not provide real parallelism (each `getInfo()` blocks the event loop).
- **Hardcoded date ranges** (2021–2026) exist throughout both files — update when extending beyond 2026.
- **Hardcoded placeholder values** in GEE responses (not computed from satellite data): `extreme_events_metrics` (rain/ temp), `distance_to_reliable_water_km`.
- **Discrepancy**: `actual_season_evaluated: 2026` in environment response metadata vs `actualYear = 2025` used in rainfall/temperature computations.
- **`.firebaserc` is gitignored** — already tracked in repo, but new clones must recreate or un-ignore it for `firebase deploy` to know the project.
- **CI workflow** (`.github/workflows/deploy.yml`) is empty — no automated deploy.
- **`firebase-functions-test`** is in devDependencies but unused; no test infrastructure exists.

## Gotchas (FastAPI / Python version)

- **`_resolve_ee_obj` helper** is used in `get_environment_data` and `get_land_security_data` to resolve EE computed objects to plain values via `getInfo()`. If fields like `slope`, `clay`, etc. appear as `{}` in JSON, it means `_resolve_ee_obj` wasn't applied.
- **GEE auth on Render**: set `gee-service-account-key.json` as a Render Secret File at `/etc/secrets/gee-service-account-key.json` OR as env var `GEE_SERVICE_ACCOUNT_KEY` with the full JSON string.
- **Date ranges** 2021–2026 are hardcoded in `gee_helper.py` — update when extending beyond 2026.
