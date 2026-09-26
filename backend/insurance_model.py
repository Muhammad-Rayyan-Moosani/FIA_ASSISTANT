"""
F1 track-zone risk & insurance model  --  "Step 2: DO THE MATHS"
=================================================================

Reads the offline JSON produced by Step 1 (no network access):

    data/tracks/*.json     track + zone metadata
    data/incidents/*.json  historical incidents (speed, barrier, location)

and answers four questions:

    1. HOW OFTEN?  crash frequency per zone with Clopper-Pearson (Binomial)
                   confidence bounds on crash probability per car-pass.
    2. HOW BAD?    impact speed -> kinetic energy (E = 1/2 m v^2) -> repair /
                   damage cost in EUR, driven by energy and barrier type.
    3. SIMULATE    Monte Carlo over N seasons -> Expected Annual Loss (EAL),
                   VaR99 and TVaR99 (portfolio, per track and per zone).
    4. PRICE       zone-by-zone technical premiums vs. one flat blanket
                   premium per track, and the EUR saved by zone pricing.

Public API
----------
    simulate(incidents_file, tracks_file, num_seasons=10_000) -> SimResults
    price(sim_results)                                        -> dict
    what_if(zone_id, param_changes)                           -> dict

Input schema (what this module expects from Step 1)
---------------------------------------------------
track file (one dict per file, or a list / {"tracks": [...]}):
    {"track_id": "monza", "name": "...", "laps": 53, "grid_size": 20,
     "races_per_season": 1, "seasons_observed": 15,
     "zones": [{"zone_id": "monza-z01", "name": "...", "x": .., "y": ..,
                "corner_speed_kph": 285, "barrier_type": "TecPro"}, ...]}
incident file (a list, or {"incidents": [...]}):
    {"incident_id": "..", "track_id": "monza", "zone_id": "monza-z01",
     "season": 2014, "corner_speed_kph": 285, "impact_speed_kph": 180,
     "barrier_type": "TecPro", "x": .., "y": ..}
`impact_speed_kph` is optional; if absent, corner_speed_kph * impact_speed_factor
is used.  `seasons_observed` is optional; if absent it is inferred from the
span of incident seasons.

IMPORTANT: every EUR parameter in ModelConfig / DEFAULT_BARRIERS is an
illustrative assumption, not calibrated market data.  Replace with real repair
invoices / reinsurance quotes before using the numbers for decisions.
"""
from __future__ import annotations

import argparse
import dataclasses
import glob
import json
import math
import warnings
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd
from scipy import stats

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

# --------------------------------------------------------------------------- #
# Configuration
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class BarrierSpec:
    """Cost behaviour of a barrier type (illustrative assumptions)."""

    fixed_eur: float            # call-out, marshals, crane, re-homologation
    per_mj_eur: float           # barrier repair / replacement per MJ absorbed
    energy_transfer: float      # share of impact energy that reaches the car (0-1)


DEFAULT_BARRIERS: dict[str, BarrierSpec] = {
    # rigid: cheap to fix, but the car takes almost all of the energy
    "concrete": BarrierSpec(15_000, 20_000, 1.00),
    "armco":    BarrierSpec(25_000, 30_000, 0.95),
    # tyre wall: cheap, decent absorption
    "tirewall": BarrierSpec(20_000, 35_000, 0.75),
    # energy-absorbing systems: car is protected, barrier modules are costly
    "safer":    BarrierSpec(60_000, 90_000, 0.60),
    "tecpro":   BarrierSpec(45_000, 70_000, 0.55),
    "unknown":  BarrierSpec(30_000, 45_000, 0.80),
}


@dataclass
class ModelConfig:
    car_mass_kg: float = 800.0                 # car + driver, regulation minimum ~ 800 kg
    impact_speed_factor: float = 0.75          # impact / corner speed when impact speed missing
    car_damage_eur_per_mj: float = 300_000.0   # car repair per MJ reaching the chassis
    severity_noise_sigma: float = 0.40         # lognormal noise on per-crash cost (mean-preserving)
    max_loss_per_incident_eur: float = 15_000_000.0  # cap ~ write-off of one car
    max_impact_speed_kph: float = 350.0
    speed_prior_strength: float = 3.0          # pseudo-observations pulling towards corner speed
    speed_prior_sigma: float = 0.15            # log-sd of impact speed prior
    speed_sigma_floor: float = 0.05
    ci_level: float = 0.95                     # confidence level for frequency bounds
    parameter_uncertainty: bool = True         # Gamma (Jeffreys) posterior on each zone's rate
    seed: int = 42
    barriers: dict[str, BarrierSpec] = field(default_factory=lambda: dict(DEFAULT_BARRIERS))


# --------------------------------------------------------------------------- #
# Loading
# --------------------------------------------------------------------------- #


def _expand(path: Any) -> list[Path]:
    """File, directory, glob pattern, or an iterable of those -> list of json files."""
    if isinstance(path, (list, tuple, set)):
        out: list[Path] = []
        for p in path:
            out.extend(_expand(p))
        return out
    s = str(path)
    if any(ch in s for ch in "*?["):
        files = sorted(Path(p) for p in glob.glob(s))
    else:
        p = Path(s)
        files = sorted(p.glob("*.json")) if p.is_dir() else ([p] if p.exists() else [])
    if not files:
        raise FileNotFoundError(f"No JSON files found for: {path!r}")
    return files


def _read_json(files: Iterable[Path]) -> list[tuple[Path, Any]]:
    return [(f, json.loads(f.read_text(encoding="utf-8"))) for f in files]


def load_tracks(tracks_file: Any) -> list[dict]:
    tracks: list[dict] = []
    for f, blob in _read_json(_expand(tracks_file)):
        items = blob.get("tracks", [blob]) if isinstance(blob, dict) else blob
        for t in items:
            t = dict(t)
            t.setdefault("track_id", f.stem)
            if not t.get("zones"):
                raise ValueError(f"{f}: track {t['track_id']!r} has no zones")
            tracks.append(t)
    return tracks


def load_incidents(incidents_file: Any) -> pd.DataFrame:
    rows: list[dict] = []
    for f, blob in _read_json(_expand(incidents_file)):
        items = blob.get("incidents", []) if isinstance(blob, dict) else blob
        rows.extend(items)
    cols = ["incident_id", "track_id", "zone_id", "season", "corner_speed_kph",
            "impact_speed_kph", "barrier_type", "x", "y"]
    df = pd.DataFrame(rows)
    for c in cols:
        if c not in df.columns:
            df[c] = np.nan
    return df[cols]


# --------------------------------------------------------------------------- #
# Zone model (frequency + severity parameters for one zone)
# --------------------------------------------------------------------------- #


def _norm_barrier(name: Any) -> str:
    s = "".join(ch for ch in str(name).lower() if ch.isalnum())
    if "tecpro" in s:
        return "tecpro"
    if "safer" in s:
        return "safer"
    if "tyre" in s or "tire" in s:
        return "tirewall"
    if "armco" in s or "guardrail" in s:
        return "armco"
    if "concrete" in s or "wall" in s:
        return "concrete"
    return "unknown"


@dataclass
class ZoneModel:
    key: str                     # "track_id/zone_id"
    track_id: str
    zone_id: str
    name: str
    barrier: str
    n_crashes: int               # observed incidents
    seasons_exposure: float      # seasons observed
    passes_per_season: float     # car-passes through the zone per season
    speed_mu: float              # ln(impact speed in kph), mean
    speed_sigma: float           # ln(impact speed in kph), sd
    mass_kg: float
    repair_cost_multiplier: float = 1.0
    frequency_multiplier: float = 1.0

    @property
    def passes(self) -> float:
        return self.passes_per_season * self.seasons_exposure


def _clopper_pearson(k: int, n: float, level: float) -> tuple[float, float]:
    a = 1.0 - level
    n = int(round(n))
    lo = 0.0 if k == 0 else stats.beta.ppf(a / 2, k, n - k + 1)
    hi = 1.0 if k == n else stats.beta.ppf(1 - a / 2, k + 1, n - k)
    return float(lo), float(hi)


def build_zone_models(tracks: list[dict], incidents: pd.DataFrame, cfg: ModelConfig) -> list[ZoneModel]:
    inc = incidents.copy()
    # impact speed: observed, else corner speed scaled
    inc["_v"] = inc["impact_speed_kph"].where(
        inc["impact_speed_kph"].notna(), inc["corner_speed_kph"] * cfg.impact_speed_factor
    )
    known = {(t["track_id"], z["zone_id"]) for t in tracks for z in t["zones"]}
    bad = inc.apply(lambda r: (r["track_id"], r["zone_id"]) not in known, axis=1) if len(inc) else pd.Series(dtype=bool)
    if bad.any():
        warnings.warn(f"Dropping {int(bad.sum())} incidents whose track/zone is not in the track files.")
        inc = inc[~bad]
    no_speed = inc["_v"].isna()
    if no_speed.any():
        warnings.warn(f"Dropping {int(no_speed.sum())} incidents with no usable speed.")
        inc = inc[~no_speed]

    if inc["season"].notna().any():
        span = float(inc["season"].max() - inc["season"].min() + 1)
    else:
        span = 1.0

    zones: list[ZoneModel] = []
    for t in tracks:
        laps = float(t.get("laps", 50))
        grid = float(t.get("grid_size", 20))
        rps = float(t.get("races_per_season", 1))
        seasons = float(t.get("seasons_observed", span))
        for z in t["zones"]:
            sub = inc[(inc["track_id"] == t["track_id"]) & (inc["zone_id"] == z["zone_id"])]
            n = len(sub)
            # barrier: zone metadata first, then the most common barrier in incidents
            barrier_raw = z.get("barrier_type")
            if barrier_raw is None and n:
                barrier_raw = sub["barrier_type"].mode().iloc[0]
            barrier = _norm_barrier(barrier_raw) if barrier_raw is not None else "unknown"

            # impact speed distribution: lognormal, shrunk towards a corner-speed prior
            corner = z.get("corner_speed_kph")
            if corner is not None:
                prior_v = float(corner) * cfg.impact_speed_factor
            elif n:
                prior_v = float(sub["_v"].mean())
            else:
                prior_v = 180.0 * cfg.impact_speed_factor
            prior_mu, k = math.log(prior_v), cfg.speed_prior_strength
            if n:
                lv = np.log(sub["_v"].to_numpy(float))
                mu = (lv.sum() + k * prior_mu) / (n + k)
                var = (n * lv.var() + k * cfg.speed_prior_sigma ** 2) / (n + k)
            else:
                mu, var = prior_mu, cfg.speed_prior_sigma ** 2
            sigma = max(math.sqrt(var), cfg.speed_sigma_floor)

            zones.append(ZoneModel(
                key=f"{t['track_id']}/{z['zone_id']}", track_id=t["track_id"], zone_id=z["zone_id"],
                name=z.get("name", z["zone_id"]), barrier=barrier, n_crashes=n,
                seasons_exposure=seasons, passes_per_season=laps * grid * rps,
                speed_mu=mu, speed_sigma=sigma, mass_kg=cfg.car_mass_kg,
            ))
    return zones


# --------------------------------------------------------------------------- #
# HOW BAD?  energy and cost
# --------------------------------------------------------------------------- #


def kinetic_energy_mj(speed_kph: np.ndarray | float, mass_kg: float) -> np.ndarray | float:
    """E = 1/2 m v^2, returned in megajoules (speed given in km/h)."""
    v = np.asarray(speed_kph, dtype=float) / 3.6
    return 0.5 * mass_kg * v ** 2 / 1e6


def crash_cost_eur(energy_mj: np.ndarray | float, barrier: str, cfg: ModelConfig,
                   cost_multiplier: float = 1.0) -> np.ndarray | float:
    """Deterministic (pre-noise) repair + damage cost for a given impact energy."""
    b = cfg.barriers.get(barrier, cfg.barriers["unknown"])
    barrier_cost = b.fixed_eur + b.per_mj_eur * energy_mj
    car_cost = cfg.car_damage_eur_per_mj * b.energy_transfer * energy_mj
    return (barrier_cost + car_cost) * cost_multiplier


def _severity_moments(zm: ZoneModel, cfg: ModelConfig) -> tuple[float, float]:
    """Analytic mean impact energy (MJ) and mean cost per crash (EUR), ignoring caps."""
    ev2 = math.exp(2 * zm.speed_mu + 2 * zm.speed_sigma ** 2)          # E[v_kph^2]
    e_mj = 0.5 * zm.mass_kg * ev2 / 3.6 ** 2 / 1e6
    return e_mj, float(crash_cost_eur(e_mj, zm.barrier, cfg, zm.repair_cost_multiplier))


# --------------------------------------------------------------------------- #
# SIMULATE  Monte Carlo
# --------------------------------------------------------------------------- #


def _simulate_zone(zm: ZoneModel, n_seasons: int, cfg: ModelConfig, seed: np.random.SeedSequence) -> np.ndarray:
    """Annual loss (EUR) for one zone over n_seasons.  Uses inverse-CDF draws for the
    frequency layer so a what-if run with the same seed uses common random numbers."""
    rng = np.random.default_rng(seed)
    u_rate, u_count = rng.random(n_seasons), rng.random(n_seasons)
    if cfg.parameter_uncertainty:      # Jeffreys posterior for the annual Poisson rate
        lam = stats.gamma.ppf(u_rate, a=zm.n_crashes + 0.5, scale=1.0 / zm.seasons_exposure)
    else:
        lam = np.full(n_seasons, zm.n_crashes / zm.seasons_exposure)
    lam = np.maximum(lam * zm.frequency_multiplier, 1e-12)
    counts = stats.poisson.ppf(u_count, lam).astype(np.int64)
    n_total = int(counts.sum())
    if n_total == 0:
        return np.zeros(n_seasons)

    z = rng.standard_normal((n_total, 2))
    speed = np.minimum(np.exp(zm.speed_mu + zm.speed_sigma * z[:, 0]), cfg.max_impact_speed_kph)
    energy = kinetic_energy_mj(speed, zm.mass_kg)
    noise = np.exp(cfg.severity_noise_sigma * z[:, 1] - 0.5 * cfg.severity_noise_sigma ** 2)
    cost = np.minimum(crash_cost_eur(energy, zm.barrier, cfg, zm.repair_cost_multiplier) * noise,
                      cfg.max_loss_per_incident_eur)
    season_idx = np.repeat(np.arange(n_seasons), counts)
    return np.bincount(season_idx, weights=cost, minlength=n_seasons)


@dataclass
class SimContext:
    cfg: ModelConfig
    zones: list[ZoneModel]
    loss: np.ndarray                       # (num_seasons, num_zones) annual loss matrix
    seeds: list[np.random.SeedSequence]


@dataclass
class SimResults:
    eal: float
    eal_se: float
    var99: float
    tvar99: float
    num_seasons: int
    zone_stats: pd.DataFrame
    track_stats: pd.DataFrame
    annual_losses: np.ndarray
    context: SimContext = field(repr=False)

    def to_dict(self) -> dict:
        return {
            "EAL": self.eal, "EAL_std_error": self.eal_se, "VaR99": self.var99, "TVaR99": self.tvar99,
            "num_seasons": self.num_seasons,
            "zone_stats": self.zone_stats.to_dict(orient="records"),
            "track_stats": self.track_stats.to_dict(orient="records"),
        }

    def __getitem__(self, k: str):
        return self.to_dict()[k]


_LAST: SimResults | None = None


def _tvar(x: np.ndarray, q: float = 0.99) -> float:
    v = np.quantile(x, q)
    tail = x[x >= v]
    return float(tail.mean()) if tail.size else float(v)


def _assemble(zones: list[ZoneModel], loss: np.ndarray, cfg: ModelConfig, seeds) -> SimResults:
    S = loss.shape[0]
    total = loss.sum(axis=1)
    rows = []
    for j, zm in enumerate(zones):
        n, T = zm.n_crashes, zm.seasons_exposure
        p = n / zm.passes
        lo, hi = _clopper_pearson(n, zm.passes, cfg.ci_level)
        e_mj, sev = _severity_moments(zm, cfg)
        lam_mean = (n + (0.5 if cfg.parameter_uncertainty else 0.0)) / T * zm.frequency_multiplier
        col = loss[:, j]
        rows.append({
            "zone_key": zm.key, "track_id": zm.track_id, "zone_id": zm.zone_id, "name": zm.name,
            "barrier": zm.barrier, "n_crashes": n, "car_passes": zm.passes,
            "crash_prob": p, "crash_prob_lo": lo, "crash_prob_hi": hi,
            "annual_rate": p * zm.passes_per_season * zm.frequency_multiplier,
            "annual_rate_lo": lo * zm.passes_per_season * zm.frequency_multiplier,
            "annual_rate_hi": hi * zm.passes_per_season * zm.frequency_multiplier,
            "median_impact_kph": math.exp(zm.speed_mu),
            "mean_energy_mj": e_mj, "mean_cost_per_crash": sev,
            "eal": col.mean(), "eal_std": col.std(ddof=1),
            "eal_analytic": lam_mean * sev,          # closed-form check (ignores caps)
            "var99": float(np.quantile(col, 0.99)),
            "tvar99": _tvar(col),
        })
    zs = pd.DataFrame(rows)
    zs["eal_share"] = zs["eal"] / zs["eal"].sum() if zs["eal"].sum() > 0 else 0.0

    trows = []
    for tid in dict.fromkeys(z.track_id for z in zones):
        idx = [j for j, z in enumerate(zones) if z.track_id == tid]
        tl = loss[:, idx].sum(axis=1)
        trows.append({"track_id": tid, "n_zones": len(idx), "eal": tl.mean(),
                      "var99": float(np.quantile(tl, 0.99)), "tvar99": _tvar(tl)})
    return SimResults(
        eal=float(total.mean()), eal_se=float(total.std(ddof=1) / math.sqrt(S)),
        var99=float(np.quantile(total, 0.99)), tvar99=_tvar(total), num_seasons=S,
        zone_stats=zs, track_stats=pd.DataFrame(trows), annual_losses=total,
        context=SimContext(cfg, zones, loss, seeds),
    )


def simulate(incidents_file: Any = DATA_DIR / "incidents", tracks_file: Any = DATA_DIR / "tracks",
             num_seasons: int = 10_000, config: ModelConfig | None = None,
             seed: int | None = None) -> SimResults:
    """Fit frequency/severity per zone from the Step-1 JSON and run the Monte Carlo.

    `incidents_file` / `tracks_file` may be a file, a directory of *.json, a glob,
    or a list of those.  The result is also cached for `what_if`.
    """
    global _LAST
    cfg = dataclasses.replace(config or ModelConfig(), **({"seed": seed} if seed is not None else {}))
    if num_seasons < 100:
        raise ValueError("num_seasons should be >= 100 for a meaningful VaR99")
    tracks, incidents = load_tracks(tracks_file), load_incidents(incidents_file)
    zones = build_zone_models(tracks, incidents, cfg)
    seeds = np.random.SeedSequence(cfg.seed).spawn(len(zones))
    loss = np.column_stack([_simulate_zone(z, num_seasons, cfg, s) for z, s in zip(zones, seeds)])
    _LAST = _assemble(zones, loss, cfg, seeds)
    return _LAST


# --------------------------------------------------------------------------- #
# PRICE
# --------------------------------------------------------------------------- #


def price(sim_results: SimResults, cost_of_capital: float = 0.08, expense_ratio: float = 0.15,
          blanket_basis: float | str = 0.75) -> dict:
    """Zone-based premiums vs. a flat blanket premium per track.

    Zone technical premium = (EAL + CoC * (VaR99 - EAL)) / (1 - expense_ratio)
        i.e. expected loss + cost of holding 99% capital, grossed up for expenses.

    Blanket premium: without zone-level pricing the insurer charges every zone the
    same flat rate.  `blanket_basis` sets that rate from the distribution of zone
    premiums on the track: a quantile in [0, 1] (default 0.75 -- the flat rate must
    lean towards the riskier zones or the book is anti-selected; 1.0 = riskiest
    zone) or "mean" (revenue-neutral, so the saving is pure cross-subsidy removal).
    THE BLANKET RULE IS AN ASSUMPTION; the saving scales with it.

    Note: zone VaRs are stand-alone (no diversification credit), so zone premiums
    are conservative in aggregate.
    """
    if not (0 <= expense_ratio < 1):
        raise ValueError("expense_ratio must be in [0, 1)")
    zs = sim_results.zone_stats.copy()
    zs["premium"] = (zs["eal"] + cost_of_capital * (zs["var99"] - zs["eal"]).clip(lower=0)) / (1 - expense_ratio)

    def flat(g: pd.Series) -> float:
        return float(g.mean()) if blanket_basis == "mean" else float(g.quantile(float(blanket_basis)))

    zs["blanket_share"] = zs.groupby("track_id")["premium"].transform(flat)
    zs["saving"] = zs["blanket_share"] - zs["premium"]

    g = zs.groupby("track_id", sort=False)
    by_track = pd.DataFrame({
        "zone_premium_total": g["premium"].sum(),
        "blanket_premium": g["blanket_share"].sum(),
        "net_saved": g["saving"].sum(),
        "overcharge_removed": g["saving"].apply(lambda s: s.clip(lower=0).sum()),
        "undercharge_exposed": g["saving"].apply(lambda s: -s.clip(upper=0).sum()),
    }).reset_index()
    by_track["net_saved_pct"] = by_track["net_saved"] / by_track["blanket_premium"]

    blanket_total = float(zs["blanket_share"].sum())
    return {
        "zone_premiums": zs[["zone_key", "track_id", "zone_id", "name", "barrier", "eal", "var99",
                             "premium", "blanket_share", "saving"]],
        "blanket_premium": blanket_total,
        "zone_premium_total": float(zs["premium"].sum()),
        "net_saved": float(zs["saving"].sum()),
        "net_saved_pct": float(zs["saving"].sum() / blanket_total) if blanket_total else 0.0,
        "cross_subsidy_removed": float(zs["saving"].clip(lower=0).sum()),
        "by_track": by_track,
        "assumptions": {"cost_of_capital": cost_of_capital, "expense_ratio": expense_ratio,
                        "blanket_basis": blanket_basis},
    }


# --------------------------------------------------------------------------- #
# WHAT IF
# --------------------------------------------------------------------------- #

_WHATIF_KEYS = {"barrier_type", "speed_factor", "speed_kph", "frequency_multiplier",
                "car_mass_kg", "repair_cost_multiplier"}


def _resolve_zone(zones: list[ZoneModel], zone_id: str) -> int:
    exact = [i for i, z in enumerate(zones) if z.key == zone_id]
    if exact:
        return exact[0]
    bare = [i for i, z in enumerate(zones) if z.zone_id == zone_id]
    if len(bare) == 1:
        return bare[0]
    if not bare:
        raise KeyError(f"Unknown zone {zone_id!r}")
    raise KeyError(f"Zone id {zone_id!r} is ambiguous; use 'track_id/zone_id'")


def _apply_changes(zm: ZoneModel, changes: dict, cfg: ModelConfig) -> ZoneModel:
    unknown = set(changes) - _WHATIF_KEYS
    if unknown:
        raise ValueError(f"Unknown param_changes {sorted(unknown)}; allowed: {sorted(_WHATIF_KEYS)}")
    new = dataclasses.replace(zm)
    if "barrier_type" in changes:
        new.barrier = _norm_barrier(changes["barrier_type"])
    if "speed_kph" in changes:                      # absolute median impact speed
        new.speed_mu = math.log(float(changes["speed_kph"]))
    if "speed_factor" in changes:                   # relative change in impact speed
        new.speed_mu += math.log(float(changes["speed_factor"]))
    if "frequency_multiplier" in changes:
        new.frequency_multiplier = zm.frequency_multiplier * float(changes["frequency_multiplier"])
    if "car_mass_kg" in changes:
        new.mass_kg = float(changes["car_mass_kg"])
    if "repair_cost_multiplier" in changes:
        new.repair_cost_multiplier = zm.repair_cost_multiplier * float(changes["repair_cost_multiplier"])
    return new


def _metrics(res: SimResults, pr: dict, idx: int) -> dict:
    z = res.zone_stats.iloc[idx]
    zp = pr["zone_premiums"].iloc[idx]
    t = res.track_stats.set_index("track_id").loc[z["track_id"]]
    bt = pr["by_track"].set_index("track_id").loc[z["track_id"]]
    return {
        "zone_annual_crash_rate": float(z["annual_rate"]),
        "zone_mean_energy_mj": float(z["mean_energy_mj"]),
        "zone_mean_cost_per_crash": float(z["mean_cost_per_crash"]),
        "zone_eal": float(z["eal"]), "zone_var99": float(z["var99"]),
        "zone_premium": float(zp["premium"]),
        "track_eal": float(t["eal"]), "track_var99": float(t["var99"]),
        "track_zone_premium_total": float(bt["zone_premium_total"]),
        "track_blanket_premium": float(bt["blanket_premium"]),
        "track_net_saved": float(bt["net_saved"]),
        "portfolio_eal": res.eal, "portfolio_var99": res.var99,
    }


def what_if(zone_id: str, param_changes: dict, sim_results: SimResults | None = None,
            price_kwargs: dict | None = None) -> dict:
    """Re-run one zone under changed parameters and compare with the baseline.

    param_changes keys: barrier_type ("TecPro", "SAFER", "Concrete", "Tyre wall"),
    speed_kph (absolute median impact speed), speed_factor (e.g. 0.9 = 10% slower),
    frequency_multiplier (e.g. 0.8 = 20% fewer crashes), car_mass_kg,
    repair_cost_multiplier.

    Uses the last `simulate()` result unless `sim_results` is given.  The zone is
    re-simulated with the same random seed (common random numbers), so differences
    reflect the parameter change, not Monte Carlo noise.
    """
    res = sim_results or _LAST
    if res is None:
        raise RuntimeError("Run simulate() first (or pass sim_results=...).")
    ctx, pk = res.context, price_kwargs or {}
    idx = _resolve_zone(ctx.zones, zone_id)

    zones = list(ctx.zones)
    zones[idx] = _apply_changes(ctx.zones[idx], param_changes, ctx.cfg)
    loss = ctx.loss.copy()
    loss[:, idx] = _simulate_zone(zones[idx], loss.shape[0], ctx.cfg, ctx.seeds[idx])
    scen = _assemble(zones, loss, ctx.cfg, ctx.seeds)

    base_m = _metrics(res, price(res, **pk), idx)
    scen_m = _metrics(scen, price(scen, **pk), idx)
    delta = {k: scen_m[k] - base_m[k] for k in base_m}
    delta_pct = {k: (delta[k] / base_m[k] if base_m[k] else float("nan")) for k in base_m}
    return {"zone": ctx.zones[idx].key, "changes": dict(param_changes),
            "baseline": base_m, "scenario": scen_m, "delta": delta, "delta_pct": delta_pct}


# --------------------------------------------------------------------------- #
# Mock data (only for demo / development)
# --------------------------------------------------------------------------- #

_MOCK_TRACKS = {
    "monza": ("Autodromo Nazionale (synthetic)", 53,
              [75, 190, 285, 140, 310, 230, 180, 245, 300, 120, 265, 210]),
    "spa":   ("Spa-Francorchamps (synthetic)", 44,
              [70, 305, 240, 190, 130, 260, 320, 150, 215, 280, 100, 245]),
}
_MOCK_BARRIERS = ["TecPro", "SAFER barrier", "Concrete", "Tire wall"]


def generate_mock_data(data_dir: Path = DATA_DIR, seed: int = 7, seasons: int = 15) -> None:
    """Write synthetic Step-1 style JSON.  NOT real data."""
    rng = np.random.default_rng(seed)
    (data_dir / "tracks").mkdir(parents=True, exist_ok=True)
    (data_dir / "incidents").mkdir(parents=True, exist_ok=True)
    first_season = 2011
    for tid, (name, laps, speeds) in _MOCK_TRACKS.items():
        zones, incidents = [], []
        for i, sp in enumerate(speeds, 1):
            th = 2 * math.pi * (i - 1) / len(speeds)
            zones.append({
                "zone_id": f"{tid}-z{i:02d}", "name": f"Zone {i}",
                "x": round(0.5 + 0.4 * math.cos(th), 4), "y": round(0.5 + 0.3 * math.sin(th), 4),
                "corner_speed_kph": sp, "barrier_type": str(rng.choice(_MOCK_BARRIERS)),
            })
        json.dump({"track_id": tid, "name": name, "laps": laps, "grid_size": 20,
                   "races_per_season": 1, "seasons_observed": seasons, "synthetic": True, "zones": zones},
                  open(data_dir / "tracks" / f"{tid}.json", "w"), indent=2)
        for z in zones:
            p_pass = 1.3e-4 * (z["corner_speed_kph"] / 200) ** 1.5 * rng.lognormal(0, 0.5)
            for s in range(seasons):
                for _ in range(rng.poisson(p_pass * laps * 20)):
                    impact = z["corner_speed_kph"] * rng.uniform(0.45, 0.95)
                    incidents.append({
                        "incident_id": f"{tid}-{len(incidents) + 1:04d}", "track_id": tid,
                        "zone_id": z["zone_id"], "season": first_season + s,
                        "corner_speed_kph": z["corner_speed_kph"], "impact_speed_kph": round(impact, 1),
                        "barrier_type": z["barrier_type"],
                        "x": round(z["x"] + rng.normal(0, 0.005), 4), "y": round(z["y"] + rng.normal(0, 0.005), 4),
                    })
        json.dump({"incidents": incidents}, open(data_dir / "incidents" / f"{tid}.json", "w"), indent=2)


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def _eur(x: float) -> str:
    return f"EUR {x:,.0f}"


def _print_summary(res: SimResults, pr: dict) -> None:
    line = "=" * 100
    print(line)
    print(f"F1 ZONE RISK MODEL  |  {res.num_seasons:,} simulated seasons  |  "
          f"{len(res.zone_stats)} zones on {len(res.track_stats)} tracks")
    print(line)
    print(f"Expected Annual Loss (EAL) : {_eur(res.eal)}   (MC std error {_eur(res.eal_se)})")
    print(f"VaR 99%                    : {_eur(res.var99)}")
    print(f"TVaR 99% (avg of worst 1%) : {_eur(res.tvar99)}")

    for tid, grp in res.zone_stats.groupby("track_id", sort=False):
        ppr = pr["zone_premiums"].set_index("zone_key")
        bt = pr["by_track"].set_index("track_id").loc[tid]
        print(f"\n--- {tid.upper()} " + "-" * 88)
        print(f"{'zone':<10}{'barrier':<9}{'n':>3} {'p(crash)/pass [95% CI]':<29}{'crash/yr':>9}"
              f"{'MJ':>6}{'EUR/crash':>11}{'EAL':>11}{'VaR99':>12}{'premium':>11}{'blanket':>11}")
        for _, r in grp.iterrows():
            p = ppr.loc[r["zone_key"]]
            ci = f"{r['crash_prob']:.2e} [{r['crash_prob_lo']:.1e},{r['crash_prob_hi']:.1e}]"
            print(f"{r['zone_id'].split('-')[-1]:<10}{r['barrier']:<9}{r['n_crashes']:>3} {ci:<29}"
                  f"{r['annual_rate']:>9.3f}{r['mean_energy_mj']:>6.2f}{r['mean_cost_per_crash']:>11,.0f}"
                  f"{r['eal']:>11,.0f}{r['var99']:>12,.0f}{p['premium']:>11,.0f}{p['blanket_share']:>11,.0f}")
        print(f"Track zone-based premium {_eur(bt['zone_premium_total'])} vs blanket {_eur(bt['blanket_premium'])}"
              f"  ->  saved {_eur(bt['net_saved'])} ({bt['net_saved_pct']:.1%})")

    print("\n" + line)
    a = pr["assumptions"]
    print(f"PRICING  (CoC {a['cost_of_capital']:.0%}, expenses {a['expense_ratio']:.0%}, blanket basis = {a['blanket_basis']})")
    print(f"Blanket premium (all tracks)    : {_eur(pr['blanket_premium'])}")
    print(f"Zone-based premium (all tracks) : {_eur(pr['zone_premium_total'])}")
    print(f"NET SAVED by zone pricing       : {_eur(pr['net_saved'])} ({pr['net_saved_pct']:.1%})")
    print(f"  of which cross-subsidy removed from over-charged zones: {_eur(pr['cross_subsidy_removed'])}")
    print(line)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--data-dir", type=Path, default=DATA_DIR)
    ap.add_argument("--seasons", type=int, default=10_000)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--mock", action="store_true",
                    help="use SYNTHETIC demo data (written to <data-dir>/mock) instead of real Step 1 output")
    args = ap.parse_args()

    if args.mock:
        base = args.data_dir / "mock"
        print(f"--mock: generating SYNTHETIC data in {base}. These are NOT real F1 figures.")
        generate_mock_data(base)
    else:
        base = args.data_dir
    tdir, idir = base / "tracks", base / "incidents"
    if not (list(tdir.glob("*.json")) and list(idir.glob("*.json"))):
        raise SystemExit(f"No Step 1 JSON in {base}.\n"
                         "Run the OpenF1 extractor first:  python backend/openf1_extract.py\n"
                         "or try the synthetic demo:       python backend/insurance_model.py --mock")

    res = simulate(idir, tdir, num_seasons=args.seasons, seed=args.seed)
    pr = price(res)
    _print_summary(res, pr)

    # what-if demo: the zone with the highest EAL that is not already on TecPro
    cand = res.zone_stats[res.zone_stats["barrier"] != "tecpro"].sort_values("eal", ascending=False)
    if cand.empty:
        return
    key = cand.iloc[0]["zone_key"]
    print(f"\nWHAT-IF on highest-EAL zone: {key}")
    for changes in ({"barrier_type": "TecPro"}, {"speed_factor": 0.90}, {"frequency_multiplier": 0.80}):
        w = what_if(key, changes)
        b, s, d, dp = w["baseline"], w["scenario"], w["delta"], w["delta_pct"]
        print(f"  {str(changes):<34} zone EAL {b['zone_eal']:>10,.0f} -> {s['zone_eal']:>10,.0f} "
              f"({dp['zone_eal']:+.1%}) | zone VaR99 {dp['zone_var99']:+.1%} | "
              f"zone premium {d['zone_premium']:+,.0f} | track EAL {d['track_eal']:+,.0f}")


if __name__ == "__main__":
    main()
