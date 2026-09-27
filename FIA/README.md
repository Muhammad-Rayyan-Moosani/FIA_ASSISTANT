# μMap & FIA Assist — Backend

> **Merged into `backend/`.** Race control now runs in the main API (`backend/api/race_control.py`, `backend/services/race_control/`) on real OpenF1 replays, and the frontend shows it on the unified map. This folder is kept for reference; the frontend no longer calls it.

FastAPI service for the μMap real-time grip-anomaly engine, the actuarial track-risk model and the FIA rulebook / team-radio assistant.

```
app/
├── main.py              # app factory, CORS, router mounting, /health
├── config.py            # all tunables (env vars, prefix UMAP_)
├── routers/
│   ├── umap.py          # /api/v1/umap/*  +  /ws/alerts
│   ├── insurance.py     # /api/v1/insurance/*  (aliased at /api/insurance/*)
│   └── fia.py           # /api/v1/fia-assistant/*
├── schemas/             # Pydantic request/response models, one file per module
├── services/
│   ├── telemetry.py     # residual engine, 25 m segments, WATCH/ALERT logic, vision fusion
│   ├── alerts.py        # WebSocket broadcaster
│   ├── homography.py    # camera → overhead map (OpenCV, NumPy fallback)
│   ├── vision.py        # YOLOv8-seg / photometric hazard detector
│   ├── openf1.py        # OpenF1 REST → TelemetrySample
│   ├── risk.py          # risk formula, Poisson-Gamma, vectorised Monte Carlo, what-if
│   ├── rag.py           # pdfplumber → chunks → sentence-transformers → FAISS
│   └── audio.py         # pydub preprocessing + faster-whisper
└── data/demo_track.json # synthetic 6-corner circuit used when no zones are posted
```

## Quick start

```bash
python -m venv .venv
.venv\Scripts\activate            # macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt   # core: API + all tests
pip install -r requirements-ml.txt  # optional: OpenCV, YOLOv8, FAISS, sentence-transformers, whisper
uvicorn app.main:app --reload --host 0.0.0.0 --port 8100
```

Interactive docs: http://localhost:8100/docs · Health: `GET /health`

Production: `uvicorn app.main:app --host 0.0.0.0 --port 8100 --workers 1`. The μMap engine and WebSocket clients live in-process, so run **one worker per race feed**. Put Redis pub/sub behind `AlertBroadcaster` if you need to scale horizontally.

Port **8100** is used so this service runs side by side with the insurance backend (`backend/`, port 8000).

## In the web app: page 2 "FIA"

The Next.js app in `frontend/` has two pages, switched with the **Insurance | FIA** tabs at the top-left:

1. **Insurance** (`/insurance`): the zone-based insurance work, served by `backend/` on port 8000.
2. **FIA** (`/fia`): this service. It has the μMap live grip map, Race director messages, the alert feed, a camera check, FIA rulebook search and team radio.

To run the whole app locally, use three terminals:

```bash
cd backend && uvicorn main:app --port 8000
cd FIA && .venv\Scripts\python -m uvicorn app.main:app --port 8100
cd frontend && npm run dev
```

Then open http://localhost:3000/fia. The page reads `NEXT_PUBLIC_FIA_API_URL` (default `http://localhost:8100`). If the FIA service is down, the page says so and the Insurance page is unaffected.

## FIA rulebook (RAG)

Put official FIA regulation PDFs in `data/rulebooks/`. At start-up the server indexes any PDF it hasn't seen before in the background (`/health` → `rulebook.status`). The index is cached in `data/rag_index/`, so later starts are instant. To build it ahead of time or add a PDF:

```bash
python scripts/ingest_rulebook.py "path/to/FIA 2026 F1 Regulations - Section B [Sporting].pdf" --query "pit lane speed limit"
python scripts/ingest_rulebook.py --rebuild     # re-index everything (e.g. after changing the embedding model)
```

The parser is tuned to the FIA layout:

- lettered article numbers (`ARTICLE B1`, `B2.4`, `B2.4.1`)
- breadcrumb headings (`ARTICLE B1 › B1.8 Driving`)
- appendices (`Appendix B2`)
- repeated page headers and footers removed
- contents pages skipped
- the PDF's broken "ff" ligature (``o`icial`` → official) repaired
- article numbers must run in order, so a wrapped line that starts with a cross-reference isn't taken as a new article

Citations look like `… Section B [Sporting] - Iss 08 - 2026-08-05 Art. B1.8.6 (p. 12)`, where the page is the PDF page.

Retrieval quality depends on the embedder. With `sentence-transformers` (all-MiniLM-L6-v2) plus FAISS, 10 of 12 test incident queries return the correct article family at rank 1. The hashing fallback is keyword-only and noticeably weaker. Install the ML stack with CPU-only PyTorch:

```bash
pip install --index-url https://download.pytorch.org/whl/cpu torch
pip install sentence-transformers faiss-cpu pdfplumber
```

## Live demo

```bash
uvicorn app.main:app --port 8100               # then open http://localhost:8100/demo
python scripts/demo_runner.py --pause           # scripted 4-act walkthrough
```

`/demo` is a live race-control dashboard (track map, WebSocket alert feed, vision overlay, Monte Carlo, rules).
The talk track is in [DEMO.md](DEMO.md). Demo routes use synthetic data from `app/services/demo_data.py`
and can be switched off with `UMAP_DEMO_ENDPOINTS=0`.

## Tests

```bash
pytest            # 33 tests, ~1–2 s, needs only requirements.txt
pytest -k umap    # one module
```

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/umap/telemetry` | Ingest a telemetry batch → residuals + WATCH/ALERT events |
| POST | `/api/v1/umap/vision-check` | Multipart frame/clip + 4-point homography → hazards in track metres |
| POST | `/api/v1/umap/replay/openf1` | Pull a session window from OpenF1 and run it through the engine |
| GET | `/api/v1/umap/segments` | Current non-green segments |
| POST | `/api/v1/umap/reset` | New session |
| WS | `/ws/alerts` | Snapshot on connect, then `HazardEvent` JSON pushes (`"ping"` → `pong`) |
| POST | `/api/v1/insurance/risk-score` | Deterministic Risk = Events × Speed × People |
| POST | `/api/insurance/risk-map` | Poisson-Gamma + 10 000-season Monte Carlo: EAL, VaR99, TVaR99, premium |
| POST | `/api/insurance/what-if` | Re-price after barrier upgrades / grandstand moves → savings, payback |
| GET | `/api/v1/insurance/series-factors` | F1/F2/F3 multipliers |
| POST | `/api/v1/fia-assistant/ingest-rulebook` | Upload regulation PDFs, build and persist the index |
| POST | `/api/v1/fia-assistant/query-rules` | Incident text → ranked article citations |
| POST | `/api/v1/fia-assistant/transcribe-radio` | Multipart audio → transcript (optionally + matching rules) |
| POST | `/api/v1/fia-assistant/transcribe-radio/raw` | Same, raw audio bytes as the request body |

### Examples

```bash
curl -X POST localhost:8100/api/insurance/risk-map -H "Content-Type: application/json" -d '{"series":"F2"}'

curl -X POST localhost:8100/api/insurance/what-if -H "Content-Type: application/json" \
  -d '{"modifications":[{"zone_id":"T8","barrier_upgrade":"tecpro","grandstand_shift_m":20}]}'

curl -X POST localhost:8100/api/v1/umap/vision-check \
  -F file=@frame.jpg \
  -F 'src_points=[[102,540],[1810,560],[1300,300],[640,295]]' \
  -F 'dst_points=[[0,0],[14,0],[14,60],[0,60]]'

curl -X POST localhost:8100/api/v1/fia-assistant/ingest-rulebook -F files=@2026_F1_Sporting_Regulations.pdf
curl -X POST localhost:8100/api/v1/fia-assistant/query-rules -H "Content-Type: application/json" \
  -d '{"incident_description":"Car 16 left the track at Turn 4 and gained a lasting advantage"}'
```

## Model notes

**Telemetry residual.** `residual = actual_decel / expected_decel`, where actual = −Δv/Δt per car (differenced across batch boundaries) and expected = `b·(A0 + A2·v²) + D2·v²` (brake fraction `b`, speed `v` in m/s). The defaults approximate an F1 car (~5 g from 300 km/h). Recalibrate per car/series with `UMAP_DECEL_*`. A sample is only scored while braking ≥ 30 % above 20 m/s. Flags expire after `UMAP_FLAG_WINDOW_S` (120 s), and a segment drops to `NONE` once they have all expired.

**Severity.** 1 car below `UMAP_RESIDUAL_THRESHOLD` (0.75) in a 25 m segment → `WATCH`. 2+ distinct cars → `ALERT`. A vision detection within 25 m of a segment raises a single-car WATCH to ALERT. Vision on its own gives WATCH. Segments are indexed by lap distance when `distance_m` is sent, and by a 25 m x/y grid otherwise.

**Vision.** If `UMAP_YOLO_WEIGHTS` points to a YOLOv8-seg model trained on hazard classes (class names containing water/wet, oil/fluid, anything else → debris), that model is used. Otherwise a photometric detector runs on the warped overhead image: bright + desaturated → water sheen, much darker than the asphalt median → oil, strongly saturated → debris. It is a baseline, not a substitute for a trained model. PatchCore or anomalib can plug in through the same `Detector` protocol. Video needs OpenCV.

**Risk formula** (implemented exactly as specified): `Events = crashes + yellow_flags + 0.1·warnings`, `SpeedFactor = (approach − top)²`, `PeopleFactor = 1 + 2e^(−grandstand/50) + 0.5e^(−marshal/50)`.

**Actuarial model.**
- Frequency: an empirical-Bayes Gamma prior centred on the circuit's pooled crash rate (`prior_strength` = α₀), with a conjugate update per zone.
- Severity: lognormal (σ = 1) with mean `base_cost[series] · (1 + SpeedFactor/20000) · PeopleFactor · barrier_factor`.
- Simulation: counts and severities are drawn fully vectorised; 10 000 seasons × 6 zones takes ~15 ms.
- Premium: `EAL·(1 + expense_loading) + cost_of_capital·(VaR99 − EAL)`.
- What-if: uses common random numbers, so the baseline-vs-upgrade difference is driven by the upgrade rather than simulation noise.
- Barrier factors, install costs and series multipliers live at the top of `services/risk.py`. **They are placeholder assumptions. Replace them with underwriting data before using any output for pricing.**

**Graceful degradation.** Without optional packages the service still runs:
- NumPy homography and warping
- hashing embedder with NumPy search in place of sentence-transformers and FAISS
- the transcription endpoints return **503** until `pydub`, `faster-whisper` and `ffmpeg` are installed
- PDF ingestion returns 503 without `pdfplumber` (`.txt` still works)

`/health` reports which backends are active.
