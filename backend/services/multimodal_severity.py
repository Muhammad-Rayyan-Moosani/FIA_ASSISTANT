"""Multimodal severity: telemetry physics + driver radio -> one severity score.

Three legs, each 0..1, fused with fixed weights (legs that are missing are dropped and the rest renormalised):

  telemetry (0.60)  the physics collision estimator: impact load, kinetic energy, speed lost, stopped car
  voice     (0.25)  Hugging Face models on the real team-radio clip: Whisper transcribes it
                    (openai/whisper-base.en), an emotion classifier reads the transcript
                    (j-hartmann/emotion-english-distilroberta-base) -> distress = fear + sadness + 0.6 anger
                    + 0.4 surprise, blended with crash / reassurance keywords ("hit the wall", "I'm OK")
  audio     (0.15)  signal features of the clip: loudness, vocal strain (1–4 kHz vs 250–1000 Hz energy)
                    and sharp transients. Plain signal processing, not a trained model.

Labels: < 0.35 Low slip · < 0.65 Medium incident · otherwise Critical crash.

Models run locally on CPU, are downloaded once from the Hugging Face hub and load lazily on first use.
If transformers / torch are not installed the voice leg is reported as unavailable (never faked).
Radio is only fetched from F1's own live-timing server (the URLs OpenF1 publishes).
"""
from __future__ import annotations

import hashlib
import io
import logging
import os
import re
import threading
import urllib.request
from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from services.data_loader import ROOT_DIR

log = logging.getLogger(__name__)

ASR_MODEL = os.getenv("FIA_ASR_MODEL", "openai/whisper-base.en")
EMOTION_MODEL = os.getenv("FIA_EMOTION_MODEL", "j-hartmann/emotion-english-distilroberta-base")
WEIGHTS = {"telemetry": 0.60, "voice": 0.25, "audio": 0.15}
LABELS = ((0.35, "Low slip"), (0.65, "Medium incident"), (1.01, "Critical crash"))
RADIO_HOST = "https://livetiming.formula1.com/"
RADIO_CACHE = ROOT_DIR / "replay" / "radio"
SAMPLE_RATE = 16_000
MAX_AUDIO_BYTES = 8 * 1024 * 1024

IMPACT_WORDS = {
    r"\bcrash(ed)?\b": 0.35, r"\b(hit|into) the (wall|barrier)\b": 0.4, r"\bwall\b": 0.2, r"\bbarrier\b": 0.2,
    r"\bbig (hit|impact|one)\b": 0.4, r"\bimpact\b": 0.25, r"\bspun\b|\bspin\b": 0.2, r"\blost it\b": 0.2,
    r"\bdamage\b": 0.2, r"\bbroken\b": 0.25, r"\bpuncture\b": 0.15, r"\bred flag\b": 0.3,
    r"\bsafety car\b": 0.15, r"\bare you (ok|okay|alright|all ?right)": 0.3, r"\bmedical\b": 0.35,
    r"\b(hurt|pain|back|neck)\b": 0.3, r"\bstopped\b": 0.2, r"\bmy fault\b|\bsorry\b": 0.1, r"\bfire\b": 0.4,
}
REASSURANCE = r"\b(i'?m|i am) (ok|okay|fine|alright)\b"


def label_for(score: float) -> str:
    return next(name for limit, name in LABELS if score < limit)


# ----------------------------------------------------------------------------- models
class _Models:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.asr = None
        self.emotion = None
        self.error: str | None = None

    def load(self) -> bool:
        if self.asr is not None and self.emotion is not None:
            return True
        with self._lock:
            if self.asr is None:
                try:
                    from transformers import logging as hf_logging, pipeline
                    hf_logging.set_verbosity_error()
                    self.asr = pipeline("automatic-speech-recognition", model=ASR_MODEL, device="cpu")
                    self.emotion = pipeline("text-classification", model=EMOTION_MODEL, top_k=None, device="cpu")
                    self.error = None
                except Exception as exc:          # not installed, no network on first download, ...
                    self.error = f"{type(exc).__name__}: {exc}"
                    log.warning("multimodal models unavailable: %s", self.error)
                    return False
        return True


MODELS = _Models()


def status() -> dict:
    return {"asr_model": ASR_MODEL, "emotion_model": EMOTION_MODEL, "loaded": MODELS.asr is not None,
            "error": MODELS.error, "weights": WEIGHTS}


# ----------------------------------------------------------------------------- audio
def fetch_radio(url: str) -> bytes:
    """Download (and cache) a team-radio clip from F1's live-timing server."""
    if not url.startswith(RADIO_HOST) or not url.lower().endswith(".mp3"):
        raise ValueError("radio clips are only fetched from livetiming.formula1.com (.mp3)")
    RADIO_CACHE.mkdir(parents=True, exist_ok=True)
    path = RADIO_CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".mp3")
    if path.exists():
        return path.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": "FIA-Assistant/1.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read(MAX_AUDIO_BYTES + 1)
    if len(data) > MAX_AUDIO_BYTES:
        raise ValueError("radio clip too large")
    path.write_bytes(data)
    return data


def decode(data: bytes) -> np.ndarray:
    """Any libsndfile-readable clip (mp3, wav, flac, ogg) -> mono float32 at 16 kHz."""
    import soundfile as sf
    from scipy.signal import resample_poly

    audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if sr != SAMPLE_RATE:
        g = np.gcd(int(sr), SAMPLE_RATE)
        audio = resample_poly(audio, SAMPLE_RATE // g, int(sr) // g).astype(np.float32)
    return audio


def audio_features(audio: np.ndarray) -> dict:
    """Loudness, vocal strain and sharp transients of a radio clip (plain signal processing)."""
    if audio.size < SAMPLE_RATE // 4:
        return {"score": 0.0, "rms_dbfs": None, "strain_ratio": None, "transients_per_s": 0.0, "duration_s": 0.0}
    frame = SAMPLE_RATE // 50                                        # 20 ms
    n = audio.size // frame
    frames = audio[: n * frame].reshape(n, frame)
    energy = np.sqrt(np.mean(frames ** 2, axis=1)) + 1e-9
    voiced = energy > np.quantile(energy, 0.35)
    rms_db = float(20 * np.log10(np.sqrt(np.mean(frames[voiced] ** 2)) + 1e-9)) if voiced.any() else -80.0
    spec = np.abs(np.fft.rfft(audio[: min(audio.size, SAMPLE_RATE * 20)]))
    freqs = np.fft.rfftfreq(min(audio.size, SAMPLE_RATE * 20), 1 / SAMPLE_RATE)
    low = spec[(freqs >= 250) & (freqs < 1000)].sum() + 1e-9
    high = spec[(freqs >= 1000) & (freqs < 4000)].sum()
    strain = float(high / low)
    db = 20 * np.log10(energy)
    jumps = int(np.sum(np.diff(db) > 12))
    dur = audio.size / SAMPLE_RATE
    loud = np.clip((rms_db + 30) / 20, 0, 1)
    strain_s = np.clip((strain - 0.5) / 1.5, 0, 1)
    trans = np.clip(jumps / dur / 2.0, 0, 1)
    return {"score": round(float(0.4 * loud + 0.35 * strain_s + 0.25 * trans), 3), "rms_dbfs": round(rms_db, 1),
            "strain_ratio": round(strain, 2), "transients_per_s": round(jumps / dur, 2), "duration_s": round(dur, 1)}


def voice_leg(transcript: str) -> dict:
    """Emotion model + crash / reassurance keywords on the transcript."""
    text = transcript.strip()
    if not text:
        return {"score": None, "emotions": {}, "keywords": [], "reassured": False}
    scores = {d["label"]: float(d["score"]) for d in MODELS.emotion(text[:512])[0]}
    distress = min(1.0, scores.get("fear", 0) + scores.get("sadness", 0) + 0.6 * scores.get("anger", 0)
                   + 0.4 * scores.get("surprise", 0))
    lower = text.lower()
    hits = [(pat, w) for pat, w in IMPACT_WORDS.items() if re.search(pat, lower)]
    kw = min(1.0, sum(w for _, w in hits))
    reassured = bool(re.search(REASSURANCE, lower))
    if reassured:
        kw = max(0.0, kw - 0.3)
    words = sorted({re.search(p, lower).group(0) for p, _ in hits})
    return {"score": round(0.55 * distress + 0.45 * kw, 3), "distress": round(distress, 3), "keyword_score": round(kw, 3),
            "emotions": {k: round(v, 3) for k, v in sorted(scores.items(), key=lambda kv: -kv[1])},
            "keywords": words, "reassured": reassured}


@lru_cache(maxsize=64)
def _analyse_clip(key: str, data: bytes) -> dict:
    audio = decode(data)
    feats = audio_features(audio)
    transcript, voice = "", {"score": None, "emotions": {}, "keywords": [], "reassured": False}
    if MODELS.load():
        out = MODELS.asr({"raw": audio, "sampling_rate": SAMPLE_RATE})
        transcript = (out.get("text") or "").strip()
        voice = voice_leg(transcript)
    return {"transcript": transcript, "voice": voice, "audio": feats}


# ----------------------------------------------------------------------------- fusion
@dataclass
class RadioInput:
    data: bytes
    source: str            # URL or upload name
    driver: str | None = None
    offset_s: float | None = None


def fuse(telemetry_score: float | None, voice_score: float | None, audio_score: float | None) -> dict:
    parts = {"telemetry": telemetry_score, "voice": voice_score, "audio": audio_score}
    used = {k: v for k, v in parts.items() if v is not None}
    if not used:
        return {"score": None, "label": None, "weights": {}}
    total_w = sum(WEIGHTS[k] for k in used)
    weights = {k: round(WEIGHTS[k] / total_w, 3) for k in used}
    score = sum(weights[k] * v for k, v in used.items())
    return {"score": round(score, 3), "label": label_for(score), "weights": weights}


def analyse(telemetry: dict | None, radio: RadioInput | None) -> dict:
    """Severity from a collision estimate (dict with telemetry_score, ...) and an optional radio clip."""
    t_score = telemetry.get("telemetry_score") if telemetry else None
    clip = None
    if radio is not None:
        try:
            clip = _analyse_clip(hashlib.sha1(radio.data).hexdigest(), radio.data)
        except Exception as exc:
            clip = {"error": f"could not analyse the clip: {exc}"}
    voice_s = clip["voice"]["score"] if clip and "voice" in clip else None
    audio_s = clip["audio"]["score"] if clip and "audio" in clip else None
    fused = fuse(t_score, voice_s, audio_s)
    return {
        **fused,
        "telemetry": telemetry,
        "radio": None if radio is None else {"source": radio.source, "driver": radio.driver, "offset_s": radio.offset_s,
                                             **(clip or {})},
        "models": {"asr": ASR_MODEL if MODELS.asr else None, "emotion": EMOTION_MODEL if MODELS.emotion else None,
                   "error": MODELS.error},
    }
