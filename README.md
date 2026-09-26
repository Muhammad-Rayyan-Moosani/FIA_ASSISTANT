<div align="center">

# 🏁 FIA Assistant

### AI Race Control + Track-Zone Insurance Intelligence for Motorsport

**Spot the crash. Advise the stewards in under 2 seconds. Insure only the zones that actually need it.**

![Status](https://img.shields.io/badge/status-hackathon%20build-e10600?style=for-the-badge)
![Python](https://img.shields.io/badge/FastAPI-Python%203.12+-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-Tailwind-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)
![Claude](https://img.shields.io/badge/AI-Claude-d97757?style=for-the-badge&logo=anthropic&logoColor=white)
![Data](https://img.shields.io/badge/data-OpenF1%20%7C%20FastF1-15151e?style=for-the-badge)

</div>

---

## ⚡ The 10-Second Pitch

> A car slams into the barrier at Parabolica. Speed falls from **290 km/h to 0 in 1.4 seconds**.
>
> 🟡 **FIA Assistant** has already spotted it, checked it against the Sporting Regulations and put a steward card on screen:
> **"Double-yellow Sector 3 → recommend VSC → marshal post 26 → investigate car #16 after the session."**
>
> 🛡️ Meanwhile, the risk engine records one more high-severity impact in that zone and **re-prices its insurance cover**.

Two products, one platform: **faster safety decisions today, and cheaper, smarter cover tomorrow.**

---

## 🚨 The Problem

| | Today | With FIA Assistant |
|---|---|---|
| **Race Control** | Stewards watch dozens of feeds and piece the evidence together by hand. Deciding on a VSC or Safety Car costs **precious seconds** while marshals and drivers are exposed. | Telemetry anomalies are detected automatically and turned into **structured advisory cards in under 2 s**, each citing the relevant regulation. |
| **Insurance (F2 / F3)** | Circuits and junior series buy **blanket cover**, paying the same for a quiet grandstand as for the braking zone where cars keep crashing. Budgets are tight and the premiums hurt. | A **spatial risk model** scores every zone (barriers, catch fencing, stands) from historical impact data, so cover goes where the crashes actually happen. |

---

## 🧩 What It Does

### 🟡 Module 1: Race Control AI Assistant
- **Replays** real or historical sessions (OpenF1 / FastF1) frame by frame
- **Detects anomalies**: sudden deceleration, stopped cars, yellow flags, VSC/SC triggers, pit-lane speeding, track limits
- **Reasons over the FIA rulebook**: a deterministic rule engine matches each anomaly to a regulation, then Claude writes the advisory
- **Outputs steward cards** with severity, recommended action, the relevant rule and confidence, in under 2 seconds. If the AI misses the latency budget, the rule engine's card is shown instead.

### 🛡️ Module 2: Track-Zone Risk & Insurance Engine
- Maps **historical crash and impact data** onto circuit zones across F1, F2 and F3
- Scores each zone's **incident probability × severity × exposure** (spectators, assets)
- Renders a **3D digital twin** of the circuit (glowing risk barriers, grandstands, loss columns) plus a **premium plan**: where to add cover, where to cut it, and how much the series saves

---

## 🏗️ Architecture

> 📐 Insurance module deep-dive (data pipeline, actuarial maths, API contracts, 3D twin, 4-person team split): **[ARCHITECTURE.md](ARCHITECTURE.md)**

```text
┌─ MODULE 1 · RACE CONTROL ────────────────────────────────────────────────────┐
│                                                                              │
│ OpenF1 telemetry ──► spot anomaly ──► match FIA rule ──► Claude ──► card     │
│ (replay / live)      (hard braking,    (instant,           (< 2 s)   on the  │
│                       stopped car,      always works)                steward │
│                       flags, pit speed)                              screen  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

┌─ MODULE 2 · INSURANCE ───────────────────────────────────────────────────────┐
│                                                                              │
│ Past incidents ──► risk per zone ──► simulate 10,000 ──► premium ──► 3D map  │
│ + GPS position     (how often?       seasons             per zone    what-if │
│ + corner speed      how bad?)        (EAL, VaR99)        vs blanket  report  │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

### API at a glance

| Endpoint | What it does |
|---|---|
| `GET  /api/replay/step` | Advance the replay; returns car positions, flags and any detected anomalies |
| `POST /api/steward/advise` | Anomaly payload in → structured FIA steward advisory card out |
| `GET  /api/insurance/risk-map` | Zone-by-zone risk scores and premium recommendations for a circuit and series |

---

## 📁 Project Structure

```
FIA_ASSISTANT/
├── ARCHITECTURE.md          # 📐 insurance module design, maths, API contracts, team split
├── backend/                 # Python · FastAPI
│   ├── main.py              # FastAPI app
│   ├── api/                 # routes (insurance.py, schemas.py)
│   ├── services/            # openf1_client · data_loader · zones · actuarial · underwriter
│   ├── config/              # settings + actuarial_params.yaml
│   ├── scripts/             # fetch_openf1.py (✅) · ingest.py
│   ├── tests/
│   ├── requirements.txt
│   └── requirements-fastf1.txt   # optional heavier FastF1 install
├── frontend/                # Next.js · TailwindCSS · React Three Fiber
│   ├── app/steward/         # 🟡 Steward Portal
│   ├── app/insurance/       # 🛡️ Insurance Risk Map (3D digital twin)
│   ├── components/insurance/
│   └── lib/
├── data/
│   ├── openf1/              # ✅ real 2024 reference laps + race-control logs (Monza, Silverstone, Spa)
│   ├── tracks/              # circuit outlines + zones + safety inventory
│   ├── incidents/           # geolocated historical incidents for the risk model
│   ├── mocks/               # API fixtures for frontend development
│   └── replay/              # demo replay sessions (steward module)
├── docs/
├── .env.example
└── README.md
```

---

## 🚀 Quick Start

**Prerequisites:** Python 3.12+, Node 20+, and an [Anthropic API key](https://console.anthropic.com/). Without a key the rule engine still produces cards.

```bash
git clone https://github.com/Muhammad-Rayyan-Moosani/FIA_ASSISTANT.git
cd FIA_ASSISTANT
cp .env.example .env        # add your ANTHROPIC_API_KEY
```

**Backend**

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m scripts.fetch_openf1      # optional: refresh real data from OpenF1
uvicorn main:app --reload --port 8000
```

**Frontend**

```bash
cd frontend
npm install
npm run dev                          # → http://localhost:3000
```

---

## 🎤 Judge Demo Flow (3 minutes)

| ⏱️ | Screen | What judges see |
|---|---|---|
| **0:00** | Landing | The problem in one line: *"Race control decides in seconds. Insurance is priced in blankets."* |
| **0:30** | 🟡 Steward Portal | Hit **Play** on the Monza replay. Cars circle a live 2D map built from real OpenF1 telemetry. |
| **1:00** | 💥 Incident | A car brakes hard and stops at Parabolica. The map flashes and a **steward card slides in with its latency badge (under 2 s)**: severity, VSC recommendation, regulation reference. |
| **1:45** | 🟡 Follow-ups | A pit-lane speeding event and a track-limits strike each raise their own card. |
| **2:15** | 🛡️ Risk Map | Switch to the Insurance view. The same circuit is now a **heat map** of high-risk zones. Toggle **F1 → F2 → F3**. |
| **2:45** | 💰 The money shot | Blanket premium vs. optimised premium: **"Same protection, lower spend."** |

---

## 🗺️ Hackathon Roadmap

**🛡️ Insurance module (building first — see [ARCHITECTURE.md](ARCHITECTURE.md))**
- [x] Repo, structure & docs
- [x] OpenF1 client + real 2024 reference data (Monza, Silverstone, Spa)
- [ ] Incident ingestion + geolocation + zones
- [ ] Actuarial engine (Poisson-Gamma · severity · Monte Carlo · pricing)
- [ ] Insurance API (risk map · simulate · what-if · report)
- [ ] 3D digital twin + control panels
- [ ] Underwriter report (LLM + PDF)

**🟡 Race Control module (next)**
- [ ] Replay engine + anomaly detector
- [ ] FIA rule evaluator + Claude steward agent
- [ ] Steward Portal UI (live map + cards)
- [ ] Demo polish 🏆

---

## ⚠️ Honest Notes

- **Advisory only.** FIA Assistant supports human stewards and never replaces them.
- **Regulations** are summarised for the prototype. A production build must load the current official FIA Sporting Regulations text.
- **Risk figures** in the demo come from sample data and illustrate the method. They are not actuarial advice.
- Telemetry via [OpenF1](https://openf1.org) and [FastF1](https://github.com/theOehrly/Fast-F1). Not affiliated with the FIA or Formula 1.

<div align="center">

**Built in 48 hours for FormulaHacks 🏎️💨**

</div>
