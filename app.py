"""PDF to Audio Book: desktop app.

Opens a PDF in a viewer window for study. Click a word to hear the text from
there onward, or select a passage to hear just that passage.
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import time
import uuid
from pathlib import Path

import webview

from engine import Narrator

APP_DIR = Path(__file__).resolve().parent
WEB_DIR = APP_DIR / "web"
SESSION_DIR = WEB_DIR / "session"          # the open PDF is copied here so the viewer can load it
VOICES_DIR = APP_DIR / "voices"
SETTINGS_PATH = APP_DIR / "settings.json"

DEFAULT_SETTINGS = {"voice": "en_US-lessac-high", "speed": 1.0, "lastDir": str(Path.home() / "Downloads")}
MAX_POSITIONS = 100  # remembered reading positions, most recent first


def load_settings() -> dict:
    try:
        return {**DEFAULT_SETTINGS, **json.loads(SETTINGS_PATH.read_text())}
    except (OSError, ValueError):
        return dict(DEFAULT_SETTINGS)


class Api:
    """Methods callable from JavaScript as window.pywebview.api.<name>()."""

    def __init__(self) -> None:
        self._window: webview.Window | None = None  # underscore: keep it out of the JS bridge
        self._narrator = Narrator(VOICES_DIR)
        self._settings = load_settings()
        self._doc_key: str | None = None  # identifies the open PDF in settings["positions"]

    # ---- setup

    def init(self) -> dict:
        voices = self._narrator.list_voices()
        voice = self._settings["voice"] if self._settings["voice"] in voices else (voices[0] if voices else None)
        return {"voices": voices, "voice": voice, "speed": self._settings["speed"]}

    def save_settings(self, voice: str, speed: float) -> None:
        self._settings.update(voice=voice, speed=speed)
        self._write_settings()

    def _write_settings(self) -> None:
        try:
            SETTINGS_PATH.write_text(json.dumps(self._settings, indent=2))
        except OSError:
            pass

    # ---- file

    def pick_pdf(self) -> dict | None:
        result = self._window.create_file_dialog(
            webview.FileDialog.OPEN,
            directory=self._settings.get("lastDir", ""),
            file_types=("PDF files (*.pdf)",),
        )
        if not result:
            return None
        path = Path(result[0] if isinstance(result, (list, tuple)) else result)
        self._settings["lastDir"] = str(path.parent)
        self._write_settings()

        self._narrator.cancel()
        SESSION_DIR.mkdir(exist_ok=True)
        for old in SESSION_DIR.glob("*.pdf"):
            old.unlink(missing_ok=True)
        copy = SESSION_DIR / f"{uuid.uuid4().hex[:8]}.pdf"  # fresh name so the viewer never caches an old file
        try:
            shutil.copyfile(path, copy)
        except OSError as exc:
            self.log("error", f"Could not read {path}: {exc}")
            return {"error": f"Could not read the file: {exc.strerror or exc}"}
        size = copy.stat().st_size
        self.log("info", f"Opened {path} ({size:,} bytes)")
        self._doc_key = f"{path.resolve()}|{size}"  # a changed file gets a fresh position
        resume = self._settings.get("positions", {}).get(self._doc_key)
        return {"url": f"session/{copy.name}", "name": path.name, "resume": resume}

    def save_position(self, offset: int) -> None:
        """Remember where reading reached in the open PDF (a text offset)."""
        if not self._doc_key:
            return
        positions = {self._doc_key: int(offset)}
        for key, value in self._settings.get("positions", {}).items():
            if key != self._doc_key and len(positions) < MAX_POSITIONS:
                positions[key] = value
        self._settings["positions"] = positions
        self._write_settings()

    # ---- diagnostics

    def log(self, level: str, message: str) -> None:
        """Write a line to app.log (the launcher sends stdout there)."""
        stamp = time.strftime("%H:%M:%S")
        print(f"{stamp} [{level}] {message}", flush=True)

    # ---- narration

    def start(self, sentences: list[str], voice: str, speed: float) -> dict:
        self.save_settings(voice, speed)
        try:
            return self._narrator.start(sentences, voice, float(speed))
        except Exception as exc:
            self.log("error", f"Could not start speech: {exc}")
            return {"error": f"{type(exc).__name__}: {exc}"}

    def chunk(self, job: str, index: int) -> dict:
        return self._narrator.chunk(job, int(index))

    def cancel(self) -> None:
        self._narrator.cancel()

    # ---- lifecycle

    def _shutdown(self) -> None:
        self._narrator.shutdown()
        for old in SESSION_DIR.glob("*.pdf"):
            old.unlink(missing_ok=True)


def main() -> None:
    api = Api()
    window = webview.create_window(
        "PDF to Audio Book",
        url=str(WEB_DIR / "index.html"),
        js_api=api,
        width=1100,
        height=900,
        min_size=(700, 500),
        background_color="#1b1c1f",
    )
    api._window = window
    window.events.closed += api._shutdown
    print(f"--- started {time.strftime('%Y-%m-%d %H:%M:%S')} (Python {sys.version.split()[0]})", flush=True)
    # PDFAB_DEBUG=1 enables the Web Inspector (right-click > Inspect Element).
    webview.start(http_server=True, debug=os.environ.get("PDFAB_DEBUG") == "1")


if __name__ == "__main__":
    main()
