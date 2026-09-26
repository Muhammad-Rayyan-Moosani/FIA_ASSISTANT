# Circuit Risk Twin — Frontend

The insurance module UI: a 3D digital twin of each circuit coloured by insurance risk, zone pricing, safety what-ifs, a live season simulation, incident ingestion and the underwriter report.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript (strict) · Tailwind CSS 4 · React Three Fiber 9 + drei · TanStack Query 5 · Zustand 5 · Vitest

Everything on screen comes from the FastAPI backend (`backend/main.py`), which serves real OpenF1-derived data for **Monza** and **Montreal**. There is no mock data in the app.

## Run it

Start the backend first (`cd backend && uvicorn main:app --port 8000`), then:

```bash
npm install
cp .env.example .env.local     # NEXT_PUBLIC_API_URL=http://localhost:8000
npm run dev                    # http://localhost:3000 → /insurance
```

| Script | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` / `npm start` | Production build / serve it |
| `npm run check` | Type-check + lint + unit tests (run before every PR) |
| `npm test` | Unit tests only (`src/**/*.test.ts`) |

Without a running backend the app shows "Can't connect to the risk API" with a retry button.

## Structure

```
src/
├── app/                 layout, providers (TanStack Query), routes
├── types/               ★ the API contract
│   ├── api.ts           shared: Series, SourceInfo (provenance), error envelope
│   ├── track.ts         STEP 1 · ingestion: circuits, tracks, zones, incidents, ingest stream events
│   └── risk.ts          STEP 3 · insurance: risk map, what-if, simulation stream events, report
├── services/            ★ the only code that talks to the backend
│   ├── http/            apiClient (fetch + timeouts + ApiError) · eventStream (typed SSE) · errors
│   ├── ingestion.service.ts   STEP 1 endpoints
│   ├── insurance.service.ts   STEP 3 endpoints
│   └── queryKeys.ts     cache keys
├── hooks/               ingestion/* · insurance/* · ui/*
├── store/               uiStore (Zustand) · crashBus (map effects event bus)
├── lib/                 pure helpers: format, labels, upgrades, riskColor, trackGeometry, zoneView
├── components/
│   ├── workspace/       InsuranceWorkspace: page orchestration
│   ├── map/             InsuranceMap · scene/ (3D) · fallback/ (2D) · ZoneStrip · overlays
│   ├── panels/          PremiumSummary · ZonePanel · WhatIfPanel · SimulatePanel · DataIngestionPanel · AssumptionsPanel
│   ├── report/          ReportDrawer
│   └── layout/ controls/ ui/
└── assets/icons/
```

**Rules of thumb**
- Components never call `fetch`. Data goes `services → hooks → components`.
- Server data lives in TanStack Query; UI choices live in `uiStore`. Crash and incident animations go through `crashBus` so they never re-render React.
- New backend field? Add it to `src/types/*` first. TypeScript will then show every place that needs it.

## Integration guide for the backend teams

The full spec is in [`ARCHITECTURE.md` §7](../ARCHITECTURE.md#7-api-specification). The types in `src/types` are the contract, so make the Pydantic models in `backend/api/schemas.py` produce exactly these shapes.

### Step 1 · Data ingestion (R1) → `src/services/ingestion.service.ts`

| Endpoint | Type | Used by |
|---|---|---|
| `GET /api/insurance/circuits` | `CircuitSummary[]` (Monza and Montreal) | circuit switcher, data coverage |
| `GET /api/insurance/tracks/{circuit}` | `TrackGeometry` | 3D/2D map, zone names, safety inventory, reference lap |
| `GET /api/insurance/incidents?circuit&zone_id` | `Incident[]` | zone incident history |
| `POST /api/insurance/incidents/ingest` | `IngestJob` | "Refresh from OpenF1" |
| `GET /api/insurance/incidents/ingest/{job_id}/stream` | SSE `IngestStreamEvent` | live progress + incidents dropping onto the map |

When the stream sends `done`, the frontend refetches circuits, the track, incidents and risk maps for that circuit.

### Step 3 · Insurance API (R3) → `src/services/insurance.service.ts`

| Endpoint | Type | Used by |
|---|---|---|
| `GET /api/insurance/risk-map?circuit&series&upgrades` | `RiskMap` | colours, strip, premium summary, zone panel |
| `GET /api/insurance/assets/{circuit}?series&upgrades` | `AssetMap` | real structures in 3D, "What insurance covers" panel |
| `POST /api/insurance/what-if` | `WhatIfRequest` → `WhatIfResponse` | safety what-if: barrier type, impact speed, crash frequency (its `risk_map` is written straight into the cache) |
| `GET /api/insurance/simulate/stream?circuit&series&seasons&upgrades` | SSE `SimulationStreamEvent` | season simulation + crash animation |
| `GET /api/insurance/report/export?…&format=json\|pdf` | `UnderwriterReport` / PDF | report drawer |

### Stream rules (both steps)

- SSE `event:` name = the event's `type`; `data:` = a JSON object with the other fields.
- Send failures as `event: stream_error` with `{code, message}`, not `error`.
- Close the stream after `done`. The client doesn't reconnect.
- Pace the simulation stream (about 0.4 s per sampled season) so crashes are watchable.

### Other rules

- **`upgrades`** is compact JSON keyed by `zone_id`, for example `{"monza-z10":{"barrier_type":"tecpro","speed_factor":0.9}}`. It's omitted when empty. Every Step 3 endpoint prices that scenario.
- **`sources`** (`provenance: measured | assumed | modelled`) drives the Real / Assumed / Calculated tags. Set it honestly per field.
- **Errors** use the envelope `{"error": {"code", "message", "detail"}}`. The `message` is shown to users.
- **CORS** must allow the frontend origin for `GET`/`POST` with `Content-Type`.
