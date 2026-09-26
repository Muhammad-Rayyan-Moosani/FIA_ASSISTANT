"""R3 · Underwriter report built from the model output (template narrative; every figure comes from the model)."""

from __future__ import annotations

import io
from datetime import datetime, timezone

from services import actuarial, repository

UPGRADE_OPTIONS = ("tecpro", "safer")
LABEL = {"tyre_wall": "tyre wall", "guardrail": "guardrail", "concrete": "concrete wall", "tecpro": "TecPro", "safer": "SAFER barrier"}


def _eur(v: float) -> str:
    a = abs(v)
    s = "-" if v < 0 else ""
    return f"{s}€{a / 1e6:.2f}M" if a >= 1e6 else f"{s}€{a / 1e3:.0f}k" if a >= 1e4 else f"{s}€{a:,.0f}"


def build(circuit: str, series: str, upgrades: dict[str, dict] | None = None) -> dict:
    upgrades = upgrades or {}
    rm = actuarial.risk_map(circuit, series, upgrades)
    track = repository.track_geometry(circuit)
    zones = {z["zone_id"]: z for z in track["zones"]}
    risk = sorted(rm["zones"], key=lambda z: z["eal_eur"], reverse=True)
    t = rm["totals"]
    cov = repository.load(circuit).track["data_coverage"]
    top3 = risk[:3]
    top_share = sum(z["share_of_loss_pct"] for z in top3)
    series_label = series.upper()

    concentrations = []
    for z in top3:
        tz = zones[z["zone_id"]]
        drivers = [f"entry speed {tz['v_entry_kph']:.0f} km/h", f"{LABEL.get(tz['barrier_type'], tz['barrier_type'])} (assumed)"]
        if tz["grandstands"]:
            drivers.append(f"grandstands: {', '.join(tz['grandstands'])}")
        concentrations.append({
            "zone_id": z["zone_id"], "share_of_loss_pct": z["share_of_loss_pct"], "drivers": drivers,
            "headline": (f"{z['crash_rate']['n_incidents']} crashes in {z['crash_rate']['exposure']:.0f} race weekends; "
                         f"expected loss {_eur(z['eal_eur'])} per weekend, 1-in-100 worst {_eur(z['var99_eur'])}."),
        })

    safety = []
    for z in sorted(rm["zones"], key=lambda z: z["premium_eur"], reverse=True):
        current = zones[z["zone_id"]]["barrier_type"]
        if current in UPGRADE_OPTIONS or (upgrades.get(z["zone_id"]) or {}).get("barrier_type"):
            continue
        best = max((actuarial.what_if(circuit, series, z["zone_id"], {"barrier_type": b}, upgrades) | {"barrier": b}
                    for b in UPGRADE_OPTIONS), key=lambda w: w["circuit_premium_before_eur"] - w["circuit_premium_after_eur"])
        saving = best["circuit_premium_before_eur"] - best["circuit_premium_after_eur"]
        if saving > 0:
            safety.append({
                "zone_id": z["zone_id"],
                "action": f"Replace the {LABEL.get(current, current)} with a {LABEL[best['barrier']]}",
                "rationale": (f"Zone expected loss {_eur(best['before']['eal_eur'])} → {_eur(best['after']['eal_eur'])}; "
                              f"risk score {best['before']['risk_score']} → {best['after']['risk_score']}."),
                "est_saving_eur": saving,
            })
        if len(safety) == 3:
            break

    run = actuarial.run(circuit, series, upgrades)
    zp = run.pr["zone_premiums"]
    premium = []
    for _, row in zp.sort_values("saving", ascending=False).iterrows():
        if abs(row["saving"]) < 1:
            continue
        over = row["saving"] > 0
        premium.append({
            "zone_id": row["zone_id"],
            "action": "Price this zone on its own risk" if over else "Keep full cover on this zone",
            "rationale": (f"A flat rate charges {_eur(row['blanket_share'])} here against a risk-based {_eur(row['premium'])}."
                          if over else
                          f"A flat rate of {_eur(row['blanket_share'])} under-prices a zone whose risk-based premium is {_eur(row['premium'])}."),
            "est_saving_eur": float(row["saving"]) if over else None,
        })
    premium = premium[:3] + [p for p in premium if p["est_saving_eur"] is None][:2]

    stands = [f"{zones[z]['short_name']}: {', '.join(zones[z]['grandstands'])}" for z in zones if zones[z]["grandstands"]]
    straights = [zones[z["zone_id"]]["short_name"] for z in rm["zones"] if z["crash_rate"]["n_incidents"] == 0]
    exposure = [f"The top three zones carry {top_share:.0f}% of expected loss.",
                f"Grandstands beside the track: {'; '.join(stands)}." if stands else "No grandstands mapped to zones."]
    if straights:
        exposure.append(f"No crashes recorded on {', '.join(straights)}; their rate comes from the model's prior.")

    names = [zones[z["zone_id"]]["short_name"] for z in top3]
    summary = (f"For an {series_label} race weekend at {track['name']}, the model expects {_eur(t['eal_eur'])} of loss, with a "
               f"1-in-100 worst weekend of {_eur(t['var99_eur'])}. {names[0]}, {names[1]} and {names[2]} carry {top_share:.0f}% of the "
               f"expected loss. Pricing each zone on its own risk costs {_eur(t['segmented_premium_eur'])} against "
               f"{_eur(t['blanket_premium_eur'])} for a flat blanket policy, a difference of {_eur(t['cost_delta_eur'])} "
               f"({t['cost_delta_pct']:.0f}%). Based on {cov['incidents']} race-control incidents from {len(cov['sessions'])} sessions, "
               f"{cov['seasons'][0]}–{cov['seasons'][-1]}.")

    caveats = [a["label"] + ": " + a["value"] for a in rm["assumptions"] if a["provenance"] == "assumed"]
    caveats.insert(0, "Barrier, run-off, fence and asset values per zone are placeholders by zone type, not surveyed.")
    caveats.insert(1, "Crashes are inferred from race-control messages (double yellows and confirmed collisions); "
                      "OpenF1 has no official crash log.")
    return {
        "circuit": circuit, "series": series, "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "narrative_source": "template", "model": None, "executive_summary": summary,
        "risk_concentrations": concentrations, "exposure_drivers": exposure,
        "premium_recommendations": premium, "safety_recommendations": safety, "caveats": caveats,
        "totals": t, "zones": rm["zones"],
    }


def pdf(report: dict, track_name: str, zone_names: dict[str, str]) -> bytes:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

    buf = io.BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                            title=f"Underwriter assessment · {track_name}")
    st = getSampleStyleSheet()
    body = [Paragraph(f"Underwriter assessment · {report['series'].upper()}", st["Heading3"]),
            Paragraph(track_name, st["Title"]), Paragraph(report["executive_summary"], st["BodyText"]), Spacer(1, 6 * mm)]
    rows = [["Zone", "Score", "EAL", "VaR99", "Premium", "Limit"]]
    for z in sorted(report["zones"], key=lambda z: z["premium_eur"], reverse=True):
        rows.append([zone_names.get(z["zone_id"], z["zone_id"]), z["risk_score"], _eur(z["eal_eur"]), _eur(z["var99_eur"]),
                     _eur(z["premium_eur"]), _eur(z["recommended_limit_eur"])])
    t = report["totals"]
    rows.append(["Circuit total", "", _eur(t["eal_eur"]), _eur(t["var99_eur"]), _eur(t["segmented_premium_eur"]), ""])
    table = Table(rows, repeatRows=1, hAlign="LEFT")
    table.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 8.5), ("ALIGN", (1, 0), (-1, -1), "RIGHT"),
                               ("LINEBELOW", (0, 0), (-1, 0), 0.6, colors.black), ("LINEABOVE", (0, -1), (-1, -1), 0.6, colors.black),
                               ("TEXTCOLOR", (0, 0), (-1, 0), colors.HexColor("#444444"))]))
    body += [table, Spacer(1, 6 * mm)]
    for title, items in (("Safety upgrades", report["safety_recommendations"]), ("Premium and cover", report["premium_recommendations"])):
        if items:
            body.append(Paragraph(title, st["Heading4"]))
            for r in items:
                body.append(Paragraph(f"<b>{zone_names.get(r['zone_id'], r['zone_id'])}:</b> {r['action']}. {r['rationale']}", st["BodyText"]))
    body.append(Paragraph("Caveats", st["Heading4"]))
    body += [Paragraph(c, st["BodyText"]) for c in report["caveats"]]
    doc.build(body)
    return buf.getvalue()
