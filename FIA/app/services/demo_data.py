"""Synthetic demo scenario: Monza Turn 1 (Variante del Rettifilo) braking zone.

Everything in this module is **mock data for demos** — stylised track geometry,
simulated telemetry, a rendered camera frame, illustrative corner statistics and
a paraphrased sample rulebook. None of it is official FIA / F1 data.

Scenario
--------
Cars come down the main straight at ~340 km/h and brake for the chicane.
An oil slick (plus a standing-water patch) sits at 545–590 m, in the heart of
the braking zone:

* Car 44 passes before the oil is dropped   -> residual ≈ 1.0, nothing raised
* Car 1  hits the oil                        -> residual ≈ 0.45 -> WATCH
* Car 2  hits the same x/y cells seconds later -> 2 cars       -> ALERT
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from app.config import TelemetryConfig
from app.services.homography import apply_homography, compute_homography
from app.services.telemetry import expected_deceleration

TRACK_NAME = "Monza — Turn 1, Variante del Rettifilo (stylised)"
TRACK_Y = 10.0            # main straight runs along +x at y = 10 m
TRACK_HALF_WIDTH = 6.0
BRAKE_POINT_S = 520.0
OIL_ZONE = (545.0, 590.0)  # along-track metres with ~45 % grip
LOW_GRIP = 0.45
DT = 0.1                   # 10 Hz telemetry

# Cars in the scenario: (car_id, session start time s, lateral offset m, hits oil?, narration)
CARS = [
    ("44", 0.0, 0.6, False, "reference lap — oil not yet on track"),
    ("1", 30.0, -0.4, True, "first car onto the oil → expect WATCH"),
    ("2", 36.0, 0.2, True, "second car, same x/y cells → expect ALERT"),
]


# --------------------------------------------------------------------------- geometry
def _build_centerline(step: float = 1.0) -> np.ndarray:
    """(N, 3) array of [s, x, y]: straight, right-left chicane, short straight."""
    parts = [(640.0, 0.0), (30.0, -1 / 18), (30.0, 1 / 18), (160.0, 0.0)]  # (length, curvature)
    pts, s, x, y, h = [[0.0, 0.0, TRACK_Y]], 0.0, 0.0, TRACK_Y, 0.0
    for length, kappa in parts:
        for _ in range(int(length / step)):
            h += kappa * step
            x += np.cos(h) * step
            y += np.sin(h) * step
            s += step
            pts.append([s, x, y])
    return np.asarray(pts)


CENTERLINE = _build_centerline()


def position_at(s: float, lateral: float = 0.0) -> tuple[float, float]:
    """Track x/y (m) at along-track distance ``s`` with a lateral offset to the left."""
    S, X, Y = CENTERLINE.T
    x, y = np.interp(s, S, X), np.interp(s, S, Y)
    hx, hy = np.interp(s + 1, S, X) - x, np.interp(s + 1, S, Y) - y
    n = np.hypot(hx, hy) or 1.0
    return float(x - hy / n * lateral), float(y + hx / n * lateral)



def locate(coords: dict) -> str | None:
    """Place name for coordinates on the demo track (used in plain-language alerts)."""
    x, y = coords.get("x"), coords.get("y")
    if x is None or y is None:
        return None
    return "Turn 1" if 400 <= x <= 800 and -80 <= y <= 60 else None


# Simulated impact, in the shape of backend/openf1_extract.detect_impacts() output (+ driver fields).
CRASH_S = 655.0
CRASH_EVENT = {"t": 44.1, "impact_speed_kph": 172.0, "entry_speed_kph": 268.0, "peak_decel_g": 18.4,
               "kind": "stop+hit", "driver": "2", "driver_code": None, "still_moving": False}

# --------------------------------------------------------------------------- telemetry
def car_run(car_id: str, t0: float, lateral: float, hits_oil: bool, cfg: TelemetryConfig | None = None) -> list[dict]:
    """10 Hz samples: flat-out approach, full braking into T1, then corner entry."""
    cfg = cfg or TelemetryConfig()
    s, v, t = 440.0, 340 / 3.6, t0
    out: list[dict] = []
    phase = "approach"
    corner_samples = 0
    while corner_samples < 10 and s < CENTERLINE[-1, 0] - 5:
        if phase == "approach" and s >= BRAKE_POINT_S:
            phase = "brake"
        if phase == "brake" and v <= 85 / 3.6:
            phase = "corner"
        brake, throttle = {"approach": (0, 100), "brake": (100, 0), "corner": (0, 35)}[phase]
        x, y = position_at(s, lateral)
        out.append({
            "car_id": car_id, "timestamp": round(t, 2), "speed_kph": round(v * 3.6, 2),
            "throttle": throttle, "brake": brake, "x": round(x, 2), "y": round(y, 2),
        })
        if phase == "brake":
            grip = LOW_GRIP if hits_oil and OIL_ZONE[0] <= s < OIL_ZONE[1] else 1.0
            a = grip * float(expected_deceleration(np.array([v]), np.array([1.0]), cfg)[0])
            v_next = max(v - a * DT, 85 / 3.6 - 0.01)
        else:
            v_next = v
            corner_samples += phase == "corner"
        s += 0.5 * (v + v_next) * DT
        v, t = v_next, t + DT
    return out


def scenario_runs() -> list[tuple[str, str, list[dict]]]:
    return [(cid, note, car_run(cid, t0, lat, oil)) for cid, t0, lat, oil, note in CARS]


# --------------------------------------------------------------------------- camera frame
CAM_SIZE = (960, 540)  # w, h
# Asphalt quad in track metres (inside the white lines) and where it appears in the camera image.
CAM_DST_M = np.array([[540, TRACK_Y + 5.5], [540, TRACK_Y - 5.5], [620, TRACK_Y - 5.5], [620, TRACK_Y + 5.5]], float)
CAM_SRC_PX = np.array([[150, 520], [810, 520], [548, 185], [412, 185]], float)
WATER = {"center": (582.0, TRACK_Y - 0.5), "radii": (7.0, 2.6)}
OIL = {"center": (561.0, TRACK_Y + 1.8), "radii": (10.0, 0.9)}


def render_camera_frame(seed: int = 7) -> np.ndarray:
    """Marshal-post camera view (RGB uint8) of the oil/water zone, rendered through a real homography."""
    w, h = CAM_SIZE
    H_px_to_m = compute_homography(CAM_SRC_PX, CAM_DST_M)
    ys, xs = np.mgrid[0:h, 0:w]
    hom = np.c_[xs.ravel(), ys.ravel(), np.ones(w * h)] @ H_px_to_m.T
    # H is defined up to scale (sign included): "in front of the camera" = same sign of w as the road quad.
    w_ref = np.r_[CAM_SRC_PX.mean(axis=0), 1.0] @ H_px_to_m[2]
    ahead = np.sign(hom[:, 2]) == np.sign(w_ref)
    mx = np.where(ahead, hom[:, 0] / hom[:, 2], np.inf).reshape(h, w)
    my = np.where(ahead, hom[:, 1] / hom[:, 2], 0).reshape(h, w)

    rng = np.random.default_rng(seed)
    img = np.empty((h, w, 3), np.float32)
    img[:] = (70, 125, 55)                                   # grass
    lateral = np.abs(my - TRACK_Y)
    asphalt = lateral <= TRACK_HALF_WIDTH
    img[asphalt] = 86
    img[asphalt & (lateral >= TRACK_HALF_WIDTH - 0.25)] = 235  # white edge lines
    for spec, color in ((WATER, (236, 239, 242)), (OIL, (24, 23, 27))):
        (cx, cy), (rx, ry) = spec["center"], spec["radii"]
        img[((mx - cx) / rx) ** 2 + ((my - cy) / ry) ** 2 <= 1] = color
    img[(mx > 900) | ~ahead.reshape(h, w)] = (150, 190, 230)  # sky / far background
    img += rng.normal(0, 6, (h, w, 1))
    return img.clip(0, 255).astype(np.uint8)


def camera_polygon_from_metres(pts_m: np.ndarray) -> np.ndarray:
    H_m_to_px = compute_homography(CAM_DST_M, CAM_SRC_PX)
    return apply_homography(H_m_to_px, pts_m)


# --------------------------------------------------------------------------- insurance
# Illustrative corner statistics (NOT official incident data) for the risk-model demo.
MONZA_ZONES = [
    {"zone_id": "T1", "name": "Variante del Rettifilo", "crashes": 6, "yellow_flags": 14, "warnings": 60,
     "seasons_observed": 6, "approach_speed_kph": 345, "top_speed_kph": 80, "grandstand_dist_m": 60,
     "marshal_dist_m": 20, "barrier_type": "tecpro"},
    {"zone_id": "T4", "name": "Variante della Roggia", "crashes": 4, "yellow_flags": 9, "warnings": 35,
     "seasons_observed": 6, "approach_speed_kph": 330, "top_speed_kph": 130, "grandstand_dist_m": 90,
     "marshal_dist_m": 25, "barrier_type": "tyre_wall"},
    {"zone_id": "T6", "name": "Lesmo 1", "crashes": 3, "yellow_flags": 5, "warnings": 12,
     "seasons_observed": 6, "approach_speed_kph": 280, "top_speed_kph": 185, "grandstand_dist_m": 150,
     "marshal_dist_m": 30, "barrier_type": "armco"},
    {"zone_id": "T7", "name": "Lesmo 2", "crashes": 4, "yellow_flags": 6, "warnings": 20,
     "seasons_observed": 6, "approach_speed_kph": 260, "top_speed_kph": 175, "grandstand_dist_m": 120,
     "marshal_dist_m": 25, "barrier_type": "armco"},
    {"zone_id": "T8", "name": "Variante Ascari", "crashes": 3, "yellow_flags": 7, "warnings": 25,
     "seasons_observed": 6, "approach_speed_kph": 330, "top_speed_kph": 190, "grandstand_dist_m": 200,
     "marshal_dist_m": 35, "barrier_type": "tyre_wall"},
    {"zone_id": "T11", "name": "Curva Alboreto (Parabolica)", "crashes": 5, "yellow_flags": 8, "warnings": 40,
     "seasons_observed": 6, "approach_speed_kph": 335, "top_speed_kph": 190, "grandstand_dist_m": 40,
     "marshal_dist_m": 15, "barrier_type": "armco"},
]
WHAT_IF = [{"zone_id": "T11", "barrier_upgrade": "tecpro"}]


# --------------------------------------------------------------------------- FIA assistant
# Written for this demo; paraphrased, NOT the official FIA text. Ingest the real PDF for real citations.
DEMO_RULEBOOK_NAME = "DemoSportingRegs"
DEMO_RULEBOOK = "\f".join([
    "ARTICLE 5 Track limits\n"
    "5.1 The track is bounded by the white lines along its edges. A car is judged to have left the track "
    "when none of its wheels remain within those lines.\n"
    "5.2 After three track limits breaches during a race, every further breach is reported to the stewards "
    "and a time penalty may be imposed.\n"
    "5.3 A driver who leaves the track may rejoin only when it is safe to do so and without gaining a lasting advantage.",
    "ARTICLE 6 Pit lane\n"
    "6.1 The pit lane speed limit is 80 km/h unless the event notes state otherwise. Exceeding the pit lane speed "
    "limit is penalised with a fine in practice and a time penalty in the race.\n"
    "6.2 A car released from its pit stop box in an unsafe condition is reported to the stewards.",
    "ARTICLE 7 Track surface hazards\n"
    "7.1 When oil, water, debris or any fluid makes part of the track slippery, the oil flag (yellow with red stripes) "
    "is shown at the marshal post before the affected zone.\n"
    "7.2 If a slippery surface or debris cannot be cleared under local yellow flags, race control may deploy the "
    "virtual safety car or the safety car.",
    "ARTICLE 8 Yellow flags\n"
    "8.1 A single waved yellow flag requires drivers to reduce speed and forbids overtaking in that sector.\n"
    "8.2 Double waved yellow flags require drivers to reduce speed significantly and be prepared to stop; "
    "overtaking is forbidden.",
])
SAMPLE_QUERIES = [
    "Car 16 exceeded the pit lane speed limit during the race",
    "Car 1 went off track at Turn 1 and gained a lasting advantage",
    "Oil on the track at Turn 1 — should race control deploy the safety car?",
    "Driver overtook under double waved yellow flags",
]
# Used when the real FIA Sporting Regulations PDF is indexed (see data/rulebooks/).
REAL_REGS_QUERIES = [
    "Car 16 exceeded the pit lane speed limit",
    "Driver left the track and gained a lasting advantage",
    "When can the safety car be deployed?",
    "Car overtook another car behind the safety car",
    "Car was released unsafely from its pit stop",
    "Driver caused a collision — what penalties can the stewards impose?",
]


@dataclass(frozen=True)
class RadioFixture:
    text: str
    segments: list[dict]
    duration_s: float


RADIO_FIXTURE = RadioFixture(
    text="Box, box. Oil at Turn 1, big oil at Turn 1, I almost lost it on the brakes. "
         "The car ahead went straight on as well. Tell race control to deploy the safety car.",
    segments=[
        {"start": 0.0, "end": 1.1, "text": "Box, box.", "avg_logprob": -0.11, "no_speech_prob": 0.01},
        {"start": 1.3, "end": 4.6, "text": "Oil at Turn 1, big oil at Turn 1, I almost lost it on the brakes.",
         "avg_logprob": -0.19, "no_speech_prob": 0.02},
        {"start": 4.9, "end": 7.2, "text": "The car ahead went straight on as well.",
         "avg_logprob": -0.23, "no_speech_prob": 0.03},
        {"start": 7.4, "end": 9.8, "text": "Tell race control to deploy the safety car.",
         "avg_logprob": -0.15, "no_speech_prob": 0.02},
    ],
    duration_s=10.1,
)
