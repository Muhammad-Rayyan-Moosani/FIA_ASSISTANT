"""Team-radio preprocessing (pydub) and transcription (faster-whisper).

pydub needs an ``ffmpeg`` binary on PATH to decode compressed formats (mp3, m4a, ogg).
The Whisper model is loaded lazily on first use and reused across requests.
"""
from __future__ import annotations

import io
import threading
from dataclasses import dataclass

import numpy as np

from app.config import AudioConfig


class AudioBackendUnavailable(RuntimeError):
    pass


@dataclass
class Transcript:
    text: str
    language: str | None
    duration_s: float
    segments: list[dict]


def preprocess(data: bytes, cfg: AudioConfig, fmt: str | None = None) -> np.ndarray:
    """Decode any ffmpeg-readable audio -> mono 16 kHz, radio-band filtered, peak-normalised float32."""
    try:
        from pydub import AudioSegment, effects
    except ImportError as exc:
        raise AudioBackendUnavailable("pydub is not installed") from exc
    try:
        seg = AudioSegment.from_file(io.BytesIO(data), format=fmt)
    except Exception as exc:
        raise ValueError(f"could not decode audio: {exc}") from exc
    seg = seg.set_channels(1).set_frame_rate(cfg.sample_rate).set_sample_width(2)
    seg = seg.high_pass_filter(cfg.highpass_hz).low_pass_filter(cfg.lowpass_hz)
    seg = effects.normalize(seg, headroom=1.0)
    return np.asarray(seg.get_array_of_samples(), dtype=np.float32) / 32768.0


class RadioTranscriber:
    def __init__(self, cfg: AudioConfig) -> None:
        self.cfg = cfg
        self._model = None
        self._lock = threading.Lock()

    @property
    def model_name(self) -> str:
        return f"faster-whisper:{self.cfg.whisper_model}"

    def _get_model(self):
        if self._model is None:
            with self._lock:
                if self._model is None:
                    try:
                        from faster_whisper import WhisperModel
                    except ImportError as exc:
                        raise AudioBackendUnavailable("faster-whisper is not installed") from exc
                    self._model = WhisperModel(
                        self.cfg.whisper_model,
                        device=self.cfg.whisper_device,
                        compute_type=self.cfg.whisper_compute_type,
                    )
        return self._model

    def transcribe(self, data: bytes, fmt: str | None = None, language: str | None = None) -> Transcript:
        audio = preprocess(data, self.cfg, fmt)
        model = self._get_model()
        segments, info = model.transcribe(
            audio, language=language, beam_size=5, vad_filter=True,
            initial_prompt="Formula 1 team radio. Box box. Safety car. Virtual safety car. Yellow flag.",
        )
        segs = [
            {"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip(),
             "avg_logprob": s.avg_logprob, "no_speech_prob": s.no_speech_prob}
            for s in segments  # generator: decoding happens here
        ]
        return Transcript(
            text=" ".join(s["text"] for s in segs).strip(),
            language=getattr(info, "language", None),
            duration_s=round(len(audio) / self.cfg.sample_rate, 2),
            segments=segs,
        )
