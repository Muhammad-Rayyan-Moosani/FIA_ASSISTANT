<div align="center">

# 🛡️ Circuit Guard

### One safety system for everyone at the track: drivers, marshals and fans

**Spot danger during the race. Find the corners that keep putting people at risk. Give insurers evidence instead of a guess.**

🏆 **Winner of the Ampere Track (AI for Motorsport Safety) at FormulaTechHacks**

![Python](https://img.shields.io/badge/FastAPI-Python%203.12-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js%2016-React%2019-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)
![Three.js](https://img.shields.io/badge/3D-React%20Three%20Fiber-15151e?style=for-the-badge&logo=threedotjs&logoColor=white)
![Claude](https://img.shields.io/badge/AI-Claude%20%7C%20Hugging%20Face-d97757?style=for-the-badge&logo=anthropic&logoColor=white)
![Data](https://img.shields.io/badge/data-OpenF1%20%7C%20OpenStreetMap-e10600?style=for-the-badge)

</div>

---

## The challenge

The **Ampere Track** asked teams to *develop an AI-powered solution that detects, predicts or prevents safety risks in motorsport*. Circuit Guard does all three:

| | How |
|---|---|
| **Detects** | Spots crashes, stopped cars and slippery track during a race, and suggests the flag or safety car to race control |
| **Predicts** | Finds the corners where serious incidents keep happening, tested against the following years' real incidents |
| **Prevents** | Turns that into low-cost fixes at those corners, and an evidence report the circuit can take to its insurer |

## Why we built it

In 2013, at the Canadian Grand Prix in Montreal, volunteer marshal Mark Robinson was clearing a crashed car when a recovery vehicle ran him over. He died.

Every crash puts more than the driver at risk: it puts the marshals who clean it up and the fans a few metres away at risk too. Driver safety and crowd safety go hand in hand, but today they're handled separately:

- **Race control** reacts to each crash on its own, under time pressure.
- **Circuits** can't say which corners keep putting people in danger.
- **Insurers** can't either, so they guess and charge for the uncertainty. Premiums have climbed so fast that in September 2025 the FIA set up a global task force on "escalating premiums, restricted coverage and reduced access" to motorsport insurance.

## What it does

Circuit Guard runs on one thing every circuit already has: its **race-control incident log**.

### 🟡 During the race: the live safety loop
- Replays **real incidents** from OpenF1 on a live 2D/3D map of the circuit.
- Spots danger (cars stopping, contact, slippery track) and shows **marshal light panels** changing sector by sector.
- A **Claude steward agent** turns each incident into a steward card: it suggests the response (yellow, double yellow, VSC, safety car or red flag) and cites the matching articles of the **FIA 2026 Sporting Regulations**, retrieved from the real rulebook. It only sees facts computed from real data, and if Claude is unavailable, a rule engine produces the card instead. Race control always makes the decision.
- A **driver cockpit warning** shows what the next car through the sector would see.
- A **wet-hairpin demo** sends a simulated aquaplaning crash through the real safety loop.
- **Severity estimate** from collision physics plus driver team radio, using local Hugging Face models (Whisper plus an emotion classifier).

### 🛡️ Between races: evidence for the circuit and its insurer
- **Risk map:** every incident is placed on the track, which is split into zones. The map shows which corners have the most serious incidents and marshal call-outs, and which of those are **right next to a grandstand**.
- **Proof that it repeats:** for each year, the 3 busiest corners from earlier years are compared with where that year's serious incidents actually happened.
- **Low-cost safety plan:** for the riskiest corners next to the crowd, cheap fixes with a sourced price for each paid item:

  | Fix | Rough cost (CAD) |
  |---|---|
  | Station medical, fire and recovery crews at the corner | Free (moves crews you already have) |
  | Refresher training for the marshals there | Free (training days are run free by licensed trainers) |
  | Move standing areas back with hired fence panels | ~300 per race weekend |
  | Two cameras on the corner | ~600, one-off |
  | A second guardrail line | ~10,000, one-off |

- **Insurer report:** where the risk is, what has been done about it, and the year-by-year count, ready to hand over at renewal.
- **Upload your own circuit:** a club uploads its track layout, corners and incident log (plus spectator areas and marshal posts, if it has them) as CSV files. Each file is checked in the browser, and the analysis runs live on screen.

## The key result

Tested on **four seasons (2023–2026) of real Formula 1 race-control data from Monza**, the 3 riskiest corners from earlier years caught **35 of the next years' 75 serious incidents (47%)**. Picking 3 of the 11 zones at random would catch about 27%. That's **1.7× better than chance**.

| Year | Caught by the top 3 from earlier years | Share |
|---|---|---|
| 2024 | 5 of 8 | 63% |
| 2025 | 6 of 27 | 22% (a miss year, shown honestly) |
| 2026 | 24 of 40 | 60% |

This shows *where* trouble keeps happening, not how bad each incident will be.

## Data

Everything in the demo is real data or a clearly labelled, sourced estimate.

| Data | Source |
|---|---|
| Race-control messages, 2023–2026, 20 sessions per circuit (Monza: 268 incidents, Montreal: 335) | [OpenF1](https://openf1.org) |
| Track shape and speed | OpenF1 fastest-lap telemetry |
| Turn and marshal-sector positions | MultiViewer circuit data |
| Grandstands, buildings, bridges and barriers | [OpenStreetMap](https://www.openstreetmap.org) |
| Rules cited on steward cards | FIA 2026 F1 Sporting Regulations |
| Safety-plan prices | Public price lists (linked in the app), Bank of Canada 2025 exchange rates |
| Insurance context | Research notes in [`reports/`](reports/): Monza's 2015 accounts, F1 promoter cover limits (US$75–100M per race), the FIA task force |

## Tech

| Part | Stack |
|---|---|
| Backend | Python 3.12, FastAPI, Pydantic v2, NumPy/SciPy, server-sent events for the live loop and ingestion |
| Frontend | Next.js 16 (App Router), React 19, TypeScript, Tailwind 4, TanStack Query, Zustand |
| 3D map | three.js with React Three Fiber and drei, with an SVG fallback |
| AI | Claude (Anthropic SDK, structured outputs) for steward cards; local Hugging Face models (Whisper plus an emotion classifier) for radio severity |
| Tests | pytest (backend), vitest (frontend) |

```
backend/
  api/            insurance.py (risk map, exposure, safety plan, upload/ingest), race_control.py (live loop)
  services/       exposure · safety_plan · zones · geolocate · ingest_jobs · race_control/ (alerts, steward agent, demo…)
  scripts/        fetch and ingest OpenF1 data
  tests/
frontend/src/
  components/     landing · workspace (unified track view) · map · panels · raceControl · plan · report
  lib/ hooks/ types/ store/
data/             OpenF1 cache, tracks, incidents, OpenStreetMap context, replays, rulebook
```

The original design document is in [ARCHITECTURE.md](ARCHITECTURE.md). The project moved on from parts of it, like the per-zone premium pricing, towards the exposure evidence and low-cost safety plan described above.

## Run it locally

**Backend** (runs offline from the cached data in `data/`)

```bash
cd backend
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # on macOS/Linux: .venv/bin/pip
.venv/Scripts/uvicorn main:app --port 8000        # API docs at http://localhost:8000/docs
```

**Frontend**

```bash
cd frontend
npm install
npm run dev                                       # http://localhost:3000
```

To try the upload flow, use the Monza demo files in `frontend/public/demo/monza/`. Blank templates are in `frontend/public/templates/`.

**Tests**

```bash
cd backend && .venv/Scripts/python -m pytest -q
cd frontend && npx vitest run
```
