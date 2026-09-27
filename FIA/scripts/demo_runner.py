"""μMap & FIA Assist — end-to-end demo runner.

Start the API, open the dashboard, then run the acts:

    uvicorn app.main:app --port 8100          # terminal 1
    open http://localhost:8100/demo           # browser (live map + alert feed)
    python scripts/demo_runner.py --pause     # terminal 2

Acts (``--act`` to run one):
  1  μMap trajectory: Car 44 clean, Car 1 hits oil → WATCH, Car 2 same x/y → ALERT (streamed at 10 Hz)
  2  Computer vision: mock camera frame → homography → segmentation → bounding boxes
  3  Insurance: 10,000-season Monte Carlo for F1/F2/F3 + TecPro what-if
  4  FIA assistant: rulebook citations + team-radio transcript → rules

All inputs are synthetic (see app/services/demo_data.py); the engines are the real ones.
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import sys
import time
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.services import demo_data as demo  # noqa: E402
from app.services.plain_alerts import merge_nearby  # noqa: E402

try:
    import websockets
except ImportError:  # pragma: no cover
    websockets = None

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

SEV = {"ALERT": "\033[97;41m", "WATCH": "\033[30;43m", "NONE": "\033[30;42m"}
B, D, R, CY, MG, GR, RD = "\033[1m", "\033[2m", "\033[0m", "\033[96m", "\033[95m", "\033[92m", "\033[91m"
OUT_DIR = ROOT / "scripts" / "demo_output"


def act_banner(n: int, title: str, say: str) -> None:
    print(f"\n{B}{'═' * 78}\n  ACT {n} · {title}\n{'═' * 78}{R}")
    print(f"  {D}🗣  {say}{R}\n")


def pause(enabled: bool, nxt: str) -> None:
    if enabled:
        input(f"\n  {D}⏎  press Enter for {nxt}…{R}")


def money(v: float) -> str:
    return f"${v / 1e6:,.2f}M"


# --------------------------------------------------------------------------- websocket tap
class AlertTap:
    """Prints every hazard event from /ws/alerts the moment it arrives."""

    def __init__(self, url: str) -> None:
        self.url, self.events, self._stop, self._task = url, [], asyncio.Event(), None

    async def __aenter__(self):
        if websockets is not None:
            self._task = asyncio.create_task(self._run())
            await asyncio.sleep(0.3)
        return self

    async def __aexit__(self, *exc):
        await asyncio.sleep(0.4)
        self._stop.set()
        if self._task:
            await self._task

    async def _run(self) -> None:
        async with websockets.connect(self.url) as ws:
            while not self._stop.is_set():
                try:
                    msg = json.loads(await asyncio.wait_for(ws.recv(), 0.2))
                except asyncio.TimeoutError:
                    continue
                if msg.get("type") not in ("hazard", "crash"):
                    continue
                self.events.append(msg)
                print_plain(msg)


def print_plain(msg: dict, indent: str = "      ") -> None:
    """Race-director view of one feed message: headline, reason, suggested action; tech detail dimmed."""
    pl = msg["plain"]
    lvl = "ALERT" if msg.get("type") == "crash" else msg["severity_level"]
    tag = "CRASH" if msg.get("type") == "crash" else lvl
    print(f"{indent}📡 {SEV[lvl]} {tag:<5} {R} {B}{pl['headline']}{R}  [{pl['flag'].replace('_', ' ')}]")
    print(f"{indent}   {pl['why']}")
    print(f"{indent}   {B}→ {pl['action']}{R}")
    if msg.get("type") == "hazard":
        p = msg["coordinates"]
        print(f"{indent}   {D}{msg['sector_id']} @ ({p['x']:.1f}, {p['y']:.1f}) m · {msg['previous_level']}→{lvl}{R}")


# --------------------------------------------------------------------------- acts
async def act1(c: httpx.AsyncClient, ws_url: str, speed: float) -> None:
    act_banner(1, "μMap — live trajectory & grip-cliff detection",
               "Three cars brake for Monza T1. Oil drops at 545–590 m. Watch the residual collapse and the alert escalate.")
    thr = (await c.get("/api/v1/demo/scenario")).json()["residual_threshold"]
    print(f"  TelemetryResidual = actual decel / expected decel · threshold {thr} · 25 m cells · 10 Hz\n")
    async with AlertTap(ws_url) as tap:
        for car_id, note, run in demo.scenario_runs():
            print(f"  🏎️  {B}Car {car_id}{R} — {note}")
            flagged, residuals = 0, []
            for s in run:
                r = (await c.post("/api/v1/demo/telemetry", json={"samples": [s]})).json()
                for p in r["residuals"]:
                    residuals.append(p["residual"])
                    if p["below_threshold"]:
                        flagged += 1
                        print(f"      {RD}▼ residual {p['residual']:.2f}{R} at ({p['x']:.1f}, {p['y']:.1f}) m "
                              f"{D}{p['speed_kph']:.0f} km/h · {p['actual_decel_ms2']:.1f} vs {p['expected_decel_ms2']:.1f} m/s² → {p['sector_id']}{R}")
                await asyncio.sleep(demo.DT / speed)
            mn = min(residuals) if residuals else float("nan")
            col = GR if mn >= thr else RD
            print(f"      scored {len(residuals)} braking samples · min residual {col}{mn:.2f}{R} · flagged {flagged}\n")
            await asyncio.sleep(0.8 / speed)
    segs = (await c.get("/api/v1/umap/segments")).json()["segments"]
    print(f"  Active segments: " + "  ".join(f"{SEV[s['severity_level']]} {s['sector_id']} {R} cars {s['cars_flagged']}" for s in segs))
    incidents = merge_nearby([e for e in tap.events if e["severity_level"] != "NONE"])
    print(f"  {D}{len(tap.events)} hazard payloads pushed over /ws/alerts → merged into "
          f"{len(incidents)} incident(s) for the race director:{R}")
    for e in incidents:
        print(f"    {B}{e['plain']['text']}{R}")


async def act2(c: httpx.AsyncClient, ws_url: str) -> None:
    act_banner(2, "Computer vision — homography + segmentation",
               "A marshal camera sees the same stretch. We flatten it to a top-down map and segment the surface.")
    async with AlertTap(ws_url):
        t0 = time.perf_counter()
        r = (await c.post("/api/v1/umap/demo-vision")).json()
        ms = (time.perf_counter() - t0) * 1000
    print(f"\n  detector={r['detector']} · camera {r['camera_size_px']} → overhead {r['overhead_size_px']} px · {ms:.0f} ms")
    print(f"  homography (image px → track m): {D}{[[round(v, 4) for v in row] for row in r['homography']]}{R}")
    for d, b in zip(r["detections"], r["camera_boxes"]):
        col = CY if d["hazard_type"] == "water_sheen" else MG
        p = d["map_coordinates"]
        poly = ", ".join(f"({x:.0f},{y:.0f})" for x, y in b["polygon_px"])
        print(f"  {col}■ {d['hazard_type']:<12}{R} conf {d['confidence']:.2f} · track ({p['x']:.1f}, {p['y']:.1f}) m · "
              f"{d['area_m2']:.1f} m²\n      overhead bbox {d['bbox_px']} · camera polygon {poly}")
    OUT_DIR.mkdir(exist_ok=True)
    for key, name in (("camera_png_b64", "camera_annotated.png"), ("overhead_png_b64", "overhead_annotated.png")):
        (OUT_DIR / name).write_bytes(base64.b64decode(r[key]))
    print(f"  🖼  saved {OUT_DIR.relative_to(ROOT)}/camera_annotated.png & overhead_annotated.png")

    print(f"\n  {B}…and if nobody acts: Car 2 loses it on the oil.{R} {D}(simulated impact, openf1_extract.detect_impacts format){R}")
    async with AlertTap(ws_url):
        await c.post("/api/v1/demo/crash")


async def act3(c: httpx.AsyncClient, series: str) -> None:
    act_banner(3, "Insurance — Bayesian Poisson-Gamma + 10,000-season Monte Carlo",
               "Per-corner crash frequency is learned Bayesian-style, then we simulate 10,000 seasons of losses.")
    zones = demo.MONZA_ZONES
    print(f"  {'Series':<7}{'Expected annual loss':>22}{'99% VaR':>14}{'99% TVaR':>14}{'Premium':>14}{'runtime':>10}")
    maps = {}
    for s in ("F1", "F2", "F3"):
        t0 = time.perf_counter()
        m = (await c.post("/api/insurance/risk-map", json={"zones": zones, "series": s})).json()
        ms = (time.perf_counter() - t0) * 1000
        maps[s] = m
        p = m["portfolio"]
        print(f"  {B}{s:<7}{R}{money(p['expected_annual_loss']):>22}{money(p['var_99']):>14}{money(p['tvar_99']):>14}"
              f"{money(p['recommended_premium']):>14}{ms:>8.0f}ms")
    print(f"\n  {series} per corner:{'λ/season':>15}{'P(crash)':>10}{'EAL':>12}{'VaR99':>12}{'Premium':>12}")
    for z in maps[series]["zones"]:
        L = z["loss"]
        print(f"  {z['zone_id']:<4}{z['name'][:22]:<24}{z['posterior_mean_rate']:>6.2f}{z['crash_probability']:>10.0%}"
              f"{money(L['expected_annual_loss']):>12}{money(L['var_99']):>12}{money(L['recommended_premium']):>12}")

    print(f"\n  {B}What-if:{R} upgrade Parabolica (T11) barrier armco → TecPro")
    w = (await c.post("/api/insurance/what-if", json={"zones": zones, "series": series, "modifications": demo.WHAT_IF})).json()
    z = w["zones"][0]
    print(f"    cost {money(w['total_upgrade_cost_usd'])} · T11 EAL {money(z['baseline_eal'])} → {money(z['modified_eal'])} · "
          f"premium −{money(w['annual_premium_saving'])}/yr")
    print(f"    circuit VaR99 {money(w['baseline']['var_99'])} → {money(w['modified']['var_99'])} · "
          f"{GR}{B}payback {w['payback_years']} years{R}")


async def act4(c: httpx.AsyncClient) -> None:
    act_banner(4, "FIA assistant — rulebook RAG + team radio",
               "Stewards describe an incident in plain English and get the exact article back.")
    scenario = (await c.get("/api/v1/demo/scenario")).json()
    print(f"  rulebook: {D}{', '.join(scenario['rulebook'])}{R}\n")
    for q in scenario["sample_queries"]:
        r = (await c.post("/api/v1/fia-assistant/query-rules", json={"incident_description": q, "top_k": 1})).json()
        cit = r["citations"][0]
        print(f"  ❓ {q}\n     📖 {CY}{B}{cit['citation']}{R} {D}(score {cit['score']:.2f}){R} {cit['text'][:95]}…")
    print(f"\n  🎙  Team radio clip (mock faster-whisper output)")
    r = (await c.post("/api/v1/fia-assistant/demo-transcribe")).json()
    for s in r["segments"]:
        print(f"     {D}[{s['start']:>4.1f}–{s['end']:>4.1f}s]{R} {s['text']}")
    print(f"     {D}model: {r['model']} · lang {r['language']} · {r['duration_s']} s{R}")
    for cit in r["related_rules"]:
        print(f"     → {CY}{cit['citation']}{R} {D}(score {cit['score']:.2f}){R}")


# --------------------------------------------------------------------------- main
async def main(a: argparse.Namespace) -> None:
    ws_url = a.base.replace("http", "ws", 1) + "/ws/alerts"
    acts = [1, 2, 3, 4] if a.act == "all" else [int(a.act)]
    async with httpx.AsyncClient(base_url=a.base, timeout=60) as c:
        try:
            h = (await c.get("/health")).json()
        except httpx.ConnectError:
            sys.exit(f"Cannot reach {a.base} — start it with: uvicorn app.main:app --port 8100")
        print(f"{B}μMap & FIA Assist — live demo{R}   {D}{a.base} · detector {h['vision_detector']} · "
              f"embeddings {h['rulebook']['embedding_backend']} · dashboard {a.base}/demo{R}")
        if a.act in ("all", "1", "4"):
            await c.post("/api/v1/demo/reset")  # clears μMap state, loads the demo rulebook
        names = {1: "Act 1", 2: "Act 2 (vision)", 3: "Act 3 (insurance)", 4: "Act 4 (FIA assistant)"}
        for i, n in enumerate(acts):
            if n == 1:
                await act1(c, ws_url, a.speed)
            elif n == 2:
                await act2(c, ws_url)
            elif n == 3:
                await act3(c, a.series)
            elif n == 4:
                await act4(c)
            if i + 1 < len(acts):
                pause(a.pause, names[acts[i + 1]])
    print(f"\n{B}Demo complete.{R}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://127.0.0.1:8100")
    ap.add_argument("--act", default="all", choices=["all", "1", "2", "3", "4"])
    ap.add_argument("--pause", action="store_true", help="wait for Enter between acts (presentation mode)")
    ap.add_argument("--speed", type=float, default=1.0, help="telemetry playback speed-up (1 = real time 10 Hz)")
    ap.add_argument("--series", default="F1", choices=["F1", "F2", "F3"], help="series for the per-corner table")
    asyncio.run(main(ap.parse_args()))
