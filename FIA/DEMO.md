# μMap & FIA Assist: 5-minute demo script

**Setup:** a laptop with two windows side by side.

- **Left:** a browser on one of two dashboards:
  - the standalone dashboard at `http://localhost:8100/demo`. It needs only the FIA service and includes the insurance Monte Carlo panel.
  - the team web app's **FIA** page (page 2) at `http://localhost:3000/fia`. It shows the same live map, Race director, feed, camera check, rulebook and radio. Its **Insurance** tab (page 1) holds the team's insurance work, so use it for Act 3 if the team backend is running. See `FIA/README.md` → "In the web app".
- **Right:** a terminal for `demo_runner.py`.

The telemetry, camera frame, corner statistics and radio transcript are synthetic. The rulebook is the **real FIA 2026 F1 Sporting Regulations (Section B, Issue 08)**, loaded from `data/rulebooks/`. **The engines are real.** The residual maths, homography, segmentation, Bayesian Monte Carlo and retrieval all run live on those inputs. Say this up front. It makes the demo more credible, not less.

---

## Before they walk in (2 min, off the clock)

```bash
cd FIA
.venv\Scripts\python -m uvicorn app.main:app --port 8100
```

1. Open `http://localhost:8100/demo` and check that the header dot is **green** ("live · /ws/alerts").
2. In a second terminal, run the dry check below. It should print "Demo complete."
3. Click **Reset demo** on the dashboard.
4. Set the speed dropdown to **1× real time**.

```bash
.venv\Scripts\python scripts\demo_runner.py --speed 5
```

---

## 0:00–0:30 · The hook

> **SAY:** "In F1, a single oil drop or a patch of standing water at the end of a 340 km/h straight is how big crashes start. Race control usually finds out from the crash. This system finds it from the *second* car. It reads the telemetry, notices a car couldn't brake as hard as physics says it should, and then waits for a second car to confirm it. It also puts a price on the risk for the insurer and pulls up the exact rule for the stewards."

> **POINT AT:** the four numbered panels: ① track map, ② vision, ③ insurance, ④ FIA assistant.

---

## 0:30–2:00 · Act 1: the grip cliff (the money shot)

> **DO:** run this in the terminal. It pauses between acts; press Enter to advance.

```bash
.venv\Scripts\python scripts\demo_runner.py --pause
```

> **SAY (Car 44 appears on the map):** "This is Monza Turn 1, the first chicane after the main straight. Each car streams speed, brake and x/y at 10 Hz. For every braking sample we compute a **residual**: the deceleration the car actually achieved, divided by what it *should* get at that speed and brake pressure. 1.0 means normal grip."

> **POINT AT:** Car 44's trail on the map is **all green**. The terminal says `min residual 1.01 · flagged 0`.

> **SAY (Car 1 hits the oil):** "Now oil has been dropped at 545 to 590 metres. Car 1 is on the brakes at 275 km/h and only getting **46%** of the deceleration it should."

> **POINT AT:**
> - the **red dots** on Car 1's trail
> - the terminal's red `▼ residual 0.46 … 20.4 vs 44.7 m/s²` lines
> - the **amber WATCH** cells on the map
> - the WATCH cards appearing in the feed

> **SAY:** "One car is a WATCH, not an alarm. It could be a driver mistake or a lock-up. We don't wave flags on one data point."

> **SAY (Car 2):** "A few seconds later, Car 2 brakes over the *same x/y cells*…"

> **POINT AT:** the cells turn **red ALERT** and the feed shows `WATCH → ALERT · 2 car(s) (1, 2)`.

> **SAY:** "Two independent cars, same 25-metre patch: that's a confirmed grip cliff. It was pushed to race control over a WebSocket the instant the second car crossed it."

> **POINT AT:** the **Race director** panel (top right). "Nobody in race control reads residuals. The same alert arrives in plain English: *SLIPPERY at Turn 1. Car 1 and Car 2 are getting very little grip. Show YELLOW flag now.* It's a suggestion. Race control decides."

> **SAY:** "Watch it escalate. After Car 1 it said *get a yellow ready*; after Car 2 it says *show yellow now*."

> **DO (optional):** click **🔇 Voice off** to turn voice on. ALERTs are then read aloud, as on a race-control radio.

> **DO:** in the top ALERT card, click **▸ WebSocket payload**.

> **POINT AT:** `sector_id`, `coordinates`, `severity_level` and `evidence_card_data`. "That's the exact JSON any race-control UI subscribes to."

---

## 2:00–2:50 · Act 2: computer vision confirms it

> **DO:** press Enter in the terminal (or click **Run camera check** on the dashboard).

> **SAY:** "Telemetry tells us *something* is wrong. The marshal-post camera tells us *what*. The camera sees the track at an angle, so we compute a **homography** from four known points. That's a perspective transform that flattens the view into a top-down map in real metres. Then we segment the surface."

> **POINT AT:**
> - Left image: the white quad (the homography region), a **cyan** box on the water sheen and a **magenta** box on the oil streak.
> - Right image: the same frame flattened to a top-down view.
> - Table: the oil at **x ≈ 561 m** and the water at **x ≈ 582 m**. Those are *exactly* the two cells telemetry flagged.

> **SAY:** "Two completely independent sensors agree on the location. In production this detector slot takes a trained YOLOv8-seg model. Here it's a brightness/colour baseline, but the homography and fusion path is identical."

> **POINT AT:** the Race director panel now reads **OIL at Turn 1**, and the suggested flag has gone up from **YELLOW** to **VSC**. "The camera told us *what* it is, so the advice escalates."

> **DO:** the terminal fires the crash automatically, or click **💥 Simulate crash** on the dashboard.

> **SAY:** "And if nobody acts: Car 2 loses it on the oil. The impact detector from our OpenF1 pipeline reports 172 km/h and 18 g, and the car has stopped. The advice jumps to **Safety Car and double yellow**. The red ✖ on the map is exactly where the oil was."

---

## 2:50–4:00 · Act 3: what it costs (insurance)

> **DO:** press Enter in the terminal, then on the dashboard click **Run 10,000 seasons**.

> **SAY:** "Now the insurer's view. For each Monza corner we learn a crash rate with a **Bayesian Poisson-Gamma** model. Corners with little history borrow strength from the rest of the circuit instead of being treated as risk-free. Then we simulate **10,000 seasons** of crashes and repair and liability costs."

> **POINT AT:**
> - the runtime: 10,000 seasons in **about 20 ms**
> - the KPIs: expected annual loss **≈ $11.1M**, 99% VaR **≈ $46.4M**, premium **≈ $17.4M**

> **SAY:** "VaR is the one-in-a-hundred-seasons bad year. That's what sets the capital the insurer has to hold."

> **DO:** click **F2**, then **F3**.

> **SAY:** "Junior series crash *more often* but each crash costs far less. F2 and F3 come out at roughly a third and a fifth of F1's expected loss."

> **DO:** click **F1**, then click **What-if: Parabolica → TecPro**.

> **SAY:** "Now the upgrade question. Parabolica has a grandstand 40 metres from an armco barrier. Swapping in TecPro energy-absorbing barriers costs **$350k**. It cuts the premium by about **$1.8M a year**, so it **pays for itself in under three months**. The worst-case (99% VaR) loss drops from $46M to $41M."

---

## 4:00–4:50 · Act 4: the stewards' assistant

> **DO:** press Enter in the terminal. On the dashboard, click the chip "Car 16 exceeded the pit lane speed limit…".

> **SAY:** "This is the actual 98-page 2026 FIA Sporting Regulations, indexed with semantic search. Stewards describe an incident in plain English and get the exact article and page back, not a vague summary."

> **POINT AT:** `Art. B1.6.3 (p. 10)` (driving in the pit lane) and its text on the 80 km/h limit and the penalties for exceeding it.

> **DO:** click the "When can the safety car be deployed?" chip.

> **POINT AT:** `Art. B5.13.1 (p. 43)`, Deployment of Safety Car. "That ties straight back to the ALERT we just raised."

> **DO (optional):** type your own incident into the box, e.g. "driver went off track and kept the position".

> **DO:** click **🎙 Process sample radio clip**.

> **SAY:** "The last input is team radio. Audio goes through noise filtering and faster-whisper speech-to-text, and the transcript is matched against the rules automatically. The driver asks for the safety car, and the system surfaces the safety-car and track-clearance articles (B1.5.2, B5.13.x) on its own. Each radio segment is searched separately, so chatter like 'box box' doesn't pollute the match."

> **POINT AT:** the timestamped transcript segments and the matched rule under them.

---

## 4:50–5:00 · Close

> **SAY:** "So: two cars and a camera turned a hidden hazard into a confirmed alert, we priced what that corner costs and what fixing it saves, and the stewards got the exact rule. It's one FastAPI backend with a live WebSocket feed and 41 automated tests."

---

## If they ask…

| Question | Answer |
|---|---|
| "Is this real data?" | "The inputs are synthetic so I can demo any time. The engines are real. I can point the telemetry at OpenF1 (`/api/v1/umap/replay/openf1`) or upload a real frame to `/vision-check`." |
| "Who decides the flag?" | "Race control, always. Every message says *Suggestion only*. The wording and the escalation ladder (yellow ready → yellow → VSC → SC) live in one small file, `app/services/plain_alerts.py`, so the stewards can tune it." |
| "Why not alert on one car?" | "False positives. One car can lock up on its own. Two independent cars in the same 25 m cell within two minutes is strong evidence. A camera hit also escalates a single-car WATCH." |
| "How do you know the *expected* deceleration?" | "It's a braking model: mechanical grip, plus aero grip that grows with speed², plus drag. It's calibrated so an F1 car pulls about 5 g from 300 km/h. The constants are env-configurable per car." |
| "Why Bayesian?" | "A corner with 0 crashes in 6 years isn't risk-free. The Gamma prior pulls sparse corners toward the circuit average, and the posterior feeds the Monte Carlo directly." |
| "Are the dollar numbers real?" | "No. Crash costs, barrier prices and corner stats are illustrative placeholders. The *method* is the point. Swap in real underwriting data and it reprices." |
| "Is that the real rulebook?" | "Yes. It's the official PDF, parsed with pdfplumber into 500 article-level chunks with page numbers, embedded with sentence-transformers and searched with FAISS. Drop a newer issue into `data/rulebooks/` and it re-indexes at start-up." |
| "Is the radio transcript live?" | "The demo uses a fixture in faster-whisper's output format because the model isn't installed on this laptop. `/transcribe-radio` runs the real pipeline once `requirements-ml.txt` and ffmpeg are installed." |
| "What about the track's other turns?" | "The engine works on any x/y. The demo geometry is only Turn 1 to keep it short." |

## If something breaks

- **Dashboard dot is red.** The server isn't running: restart uvicorn and refresh.
- **The feed stays empty.** Click **Reset demo**, then **▶ Run trajectory** on the dashboard. The server streams the same scenario itself, no terminal needed.
- **Everything is on fire.** Run `pytest` to show 41 passing tests, then walk through `/docs` (the Swagger UI).

## Runner options

```bash
.venv\Scripts\python scripts\demo_runner.py --pause
```

Flags:

- `--pause` waits for Enter between acts.
- `--act 1|2|3|4` runs a single act.
- `--speed 3` plays the telemetry faster.
- `--series F2` sets the series for the per-corner table.
