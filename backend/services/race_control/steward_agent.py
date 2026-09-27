"""Claude steward agent: the structured incident in, a steward advisory card out.

Pipeline position (the FIA safety loop):
  telemetry -> physics collision estimator / grip engine -> incident payload
  -> retrieval over the real FIA Sporting Regulations (rulebook.py)
  -> THIS: Claude turns facts + articles into what race control, marshals and the drivers behind need
  -> masts, cockpit displays, steward card

The model only sees facts computed from real OpenF1 data and the retrieved articles, and is told to cite only
those articles. The output is schema-constrained JSON (structured outputs), validated again with Pydantic.
Every card is decision support: race control decides.

No API key, a timeout or a refusal -> the deterministic rule-engine card is used and labelled as such.
"""
from __future__ import annotations

import json
import logging
import time
from typing import Literal

from pydantic import BaseModel, Field, ValidationError

from config.settings import settings

log = logging.getLogger(__name__)

Action = Literal["SAFETY_CAR", "VSC", "RED_FLAG", "DOUBLE_YELLOW", "YELLOW", "MONITOR"]


class DriverMessage(BaseModel):
    driver: str = Field(description="car number, as given")
    message: str = Field(description="steering-wheel display text, capitals, max 40 characters")
    avoidance: str = Field(description="the one concrete avoidance step for this driver, max 90 characters")


class StewardAdvisory(BaseModel):
    headline: str = Field(description="max 60 characters")
    recommended_action: Action
    reasoning: str = Field(description="two sentences, citing article numbers from the provided list")
    citations: list[str] = Field(description="article numbers used, only from the provided list")
    driver_messages: list[DriverMessage]
    steward_steps: list[str] = Field(description="ordered actions for race control, max 4, each max 90 characters")
    marshal_instructions: str = Field(description="max 140 characters")
    spectator_safety: str = Field(description="what this means for the people in the stands nearby, max 140 characters")
    confidence: Literal["low", "medium", "high"]


SYSTEM = """You are the AI assistant in an FIA Formula 1 race control room. A crash or loss of grip has just been \
detected from live telemetry. Write the steward advisory card.

Rules:
- Use only the facts in the incident payload. Do not invent speeds, cars, distances or damage.
- Cite only articles from the provided regulation excerpts, by their article number.
- One driver message per car listed in cars_behind: what the steering-wheel display shows and the single most \
useful avoidance step for that car (lift / slow in the sector, the side of the track to use, no overtaking, keep \
the delta), sized to how far behind it is.
- Recommend the least disruptive call that makes the scene safe: a stopped car at speed near the racing line or \
barrier damage usually needs the Safety Car; a car that can be recovered quickly from the run-off usually needs \
the VSC; a car still moving needs double yellow.
- Mention the spectators when grandstands are within reach of the crash point.
- This is decision support for race control, who decide. Be terse; the card is read in two seconds."""


def _schema() -> dict:
    schema = StewardAdvisory.model_json_schema()

    def strict(node):                       # structured outputs need closed objects with every key required
        if isinstance(node, dict):
            if node.get("type") == "object" and "properties" in node:
                node["additionalProperties"] = False
                node["required"] = list(node["properties"])
            for v in node.values():
                strict(v)
        elif isinstance(node, list):
            for v in node:
                strict(v)
    strict(schema)
    return schema


SCHEMA = _schema()
_client = None


def configured() -> bool:
    return bool(settings.anthropic_api_key)


def _get_client():
    global _client
    if _client is None:
        import anthropic
        _client = anthropic.Anthropic(api_key=settings.anthropic_api_key, timeout=settings.steward_timeout_s, max_retries=1)
    return _client


def payload(incident: dict, severity: dict | None, cars_behind: list[dict], rules: list[dict]) -> dict:
    """The facts the model sees (all computed from real data upstream)."""
    c = incident.get("collision") or {}
    ins = incident.get("insurance") or {}
    return {
        "race_control_message": incident.get("raw_message"),
        "session": f"{incident.get('session_type')} {incident.get('season')}",
        "where": {"zone": incident.get("zone_name"), "marshal_sector": incident.get("marshal_sector")},
        "telemetry": ({"car": c.get("driver"), "impact_speed_kph": round(c["impact_speed_kph"]), "peak_decel_g": round(c["peak_long_g"], 1),
                       "energy_mj": round(c["energy_mj"], 2), "stopped": c.get("stopped"), "level": c.get("level")} if c else None),
        "rule_engine_suggestion": incident.get("advice", {}).get("flag"),
        "severity": ({"label": severity.get("label"), "score": severity.get("score"),
                      "radio_transcript": (severity.get("radio") or {}).get("transcript")} if severity else None),
        "cars_behind": cars_behind,
        "structures_within_200m": [{"name": s.get("name") or s["category"], "category": s["category"], "distance_m": s["distance_m"]}
                                   for s in ins.get("structures_at_risk", [])][:5],
        "regulation_excerpts": [{"article": r.get("article"), "text": r["text"][:700]} for r in rules[:3]],
    }


def advise(incident: dict, severity: dict | None, cars_behind: list[dict], rules: list[dict]) -> dict:
    """Claude's advisory, or None-with-reason when the agent is unavailable (caller falls back to the rule engine)."""
    if not configured():
        return {"source": "rules", "reason": "ANTHROPIC_API_KEY not set: showing the rule engine's card"}
    import anthropic
    facts = payload(incident, severity, cars_behind, rules)
    t0 = time.perf_counter()
    try:
        response = _get_client().beta.messages.create(
            model=settings.anthropic_model,
            max_tokens=2000,
            system=SYSTEM,
            messages=[{"role": "user", "content": "Incident payload:\n" + json.dumps(facts, ensure_ascii=False)}],
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        )
    except anthropic.APITimeoutError:
        return {"source": "rules", "reason": f"Claude did not answer within {settings.steward_timeout_s:.0f} s"}
    except anthropic.AuthenticationError:
        return {"source": "rules", "reason": "the Anthropic API key was rejected"}
    except anthropic.RateLimitError:
        return {"source": "rules", "reason": "Anthropic rate limit reached"}
    except anthropic.APIStatusError as exc:
        return {"source": "rules", "reason": f"Anthropic API error {exc.status_code}"}
    except anthropic.APIConnectionError:
        return {"source": "rules", "reason": "could not reach the Anthropic API"}
    latency_ms = round((time.perf_counter() - t0) * 1000)
    if response.stop_reason == "refusal":
        return {"source": "rules", "reason": "the model declined this request"}
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        card = StewardAdvisory.model_validate_json(text)
    except ValidationError as exc:
        log.warning("steward advisory failed validation: %s", exc)
        return {"source": "rules", "reason": "the model's card did not validate"}
    allowed = {str(r.get("article")) for r in rules}
    card.citations = [a for a in card.citations if a in allowed]          # never show an article we did not retrieve
    return {"source": "claude", "model": response.model, "latency_ms": latency_ms,
            "within_budget": latency_ms <= settings.steward_latency_budget_ms, "budget_ms": settings.steward_latency_budget_ms,
            **card.model_dump()}
