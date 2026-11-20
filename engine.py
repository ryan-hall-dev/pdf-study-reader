"""Narration engine: turns a list of sentences into audio with Piper, on demand.

Speech is generated only a few sentences ahead of what the listener has asked for,
kept in memory, and discarded once played. Nothing is written to disk.
"""

from __future__ import annotations

import base64
import re
import threading
import unicodedata
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from piper import PiperVoice, SynthesisConfig

SENTENCE_PAUSE_SEC = 0.25  # silence after each sentence
LOOKAHEAD = 4              # sentences generated beyond the latest one requested
KEEP_BEHIND = 2            # already-fetched sentences kept before being freed


# --------------------------------------------------------------------------- text


def clean_text(text: str) -> str:
    """Normalise PDF-extracted text into a single readable sentence."""
    text = unicodedata.normalize("NFKC", text)          # ligatures such as "ﬁ" -> "fi"
    text = re.sub(r"(\w)-\s*\n\s*(\w)", r"\1\2", text)  # words hyphenated across lines
    text = re.sub(r"\s+", " ", text)                    # line breaks -> spaces
    return text.strip()


def is_speakable(text: str) -> bool:
    """Skip fragments with no letters (page numbers, bullets, stray symbols)."""
    return bool(re.search(r"[^\W\d_]", text))


# --------------------------------------------------------------------------- jobs


@dataclass
class Job:
    id: str
    sentences: list[str]
    audio: dict[int, bytes] = field(default_factory=dict)  # index -> 16-bit PCM (b"" = nothing to say)
    generated: int = 0          # sentences generated so far
    wanted: int = 0             # highest index the player has asked for
    cancelled: bool = False
    error: str | None = None
    cond: threading.Condition = field(default_factory=threading.Condition)
    thread: threading.Thread | None = None

    @property
    def finished(self) -> bool:
        return self.generated >= len(self.sentences) or self.error is not None


class Narrator:
    def __init__(self, voices_dir: Path) -> None:
        self.voices_dir = voices_dir
        self._voices: dict[str, PiperVoice] = {}
        self._job: Job | None = None
        self._lock = threading.Lock()

    # ---- voices

    def list_voices(self) -> list[str]:
        return sorted(
            p.stem for p in self.voices_dir.glob("*.onnx")
            if p.with_suffix(".onnx.json").exists()
        )

    def _load_voice(self, name: str) -> PiperVoice:
        if name not in self._voices:
            self._voices[name] = PiperVoice.load(str(self.voices_dir / f"{name}.onnx"))
        return self._voices[name]

    # ---- job control

    def start(self, sentences: list[str], voice_name: str, speed: float) -> dict:
        self.cancel()
        voice = self._load_voice(voice_name)
        job = Job(id=uuid.uuid4().hex[:12], sentences=sentences)
        config = SynthesisConfig(length_scale=1.0 / max(speed, 0.25))
        job.thread = threading.Thread(target=self._run, args=(job, voice, config), daemon=True)
        with self._lock:
            self._job = job
        job.thread.start()
        return {"job": job.id, "sampleRate": voice.config.sample_rate, "total": len(sentences)}

    def cancel(self) -> None:
        with self._lock:
            job, self._job = self._job, None
        if job is None:
            return
        with job.cond:
            job.cancelled = True
            job.cond.notify_all()
        if job.thread is not None:
            job.thread.join(timeout=10)

    def _run(self, job: Job, voice: PiperVoice, config: SynthesisConfig) -> None:
        silence = b"\x00\x00" * int(voice.config.sample_rate * SENTENCE_PAUSE_SEC)
        try:
            for i, raw in enumerate(job.sentences):
                # Wait until the player is close enough to need this sentence.
                with job.cond:
                    job.cond.wait_for(lambda: job.cancelled or i <= job.wanted + LOOKAHEAD)
                    if job.cancelled:
                        return
                text = clean_text(raw)
                pcm = b""
                if is_speakable(text):
                    pcm = b"".join(c.audio_int16_bytes for c in voice.synthesize(text, syn_config=config))
                    pcm += silence
                with job.cond:
                    job.audio[i] = pcm
                    job.generated = i + 1
                    job.cond.notify_all()
        except Exception as exc:  # surfaced to the UI via chunk()
            job.error = f"{type(exc).__name__}: {exc}"

    # ---- queries used by the UI

    def chunk(self, job_id: str, index: int) -> dict:
        """Audio for one sentence, as base64 16-bit PCM."""
        with self._lock:
            job = self._job
        if job is None or job.id != job_id:
            return {"cancelled": True}
        with job.cond:
            if index > job.wanted:
                job.wanted = index
                job.cond.notify_all()
            if job.error and index not in job.audio:
                return {"error": job.error}
            if index >= len(job.sentences):
                return {"end": True}
            if index not in job.audio:
                return {"pending": True}
            pcm = job.audio[index]
            for old in [k for k in job.audio if k < index - KEEP_BEHIND]:
                del job.audio[old]  # free audio that has already been handed over
        if not pcm:
            return {"empty": True}
        return {"pcm": base64.b64encode(pcm).decode("ascii")}

    def shutdown(self) -> None:
        self.cancel()
