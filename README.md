# PDF to Audio Book

A study reader: open a PDF and have a Piper neural voice read it to you.
Click a word to hear the text from there onward, or select a passage to hear
just that passage. Nothing is saved; speech is generated as you listen.

## Setup (once)

```bash
cd "/Users/ryan/Projects/apps/PDF to Audio Book"
source .venv/bin/activate
pip install -r requirements.txt
python -m piper.download_voices en_US-lessac-high --download-dir voices   # skip if already downloaded
chmod +x make_launcher.sh && ./make_launcher.sh
```

That puts **PDF to Audio Book.app** on your Desktop.

## Using it

- Double-click the Desktop icon: a file picker opens; choose a PDF.
- **Click a word**, then press **Play** (or Space): reads from that word onward.
- **Drag-select a passage**, then press Play: reads only that passage, then stops.
- The spoken sentence is highlighted and the page scrolls with it. Scrolling yourself
  pauses **Follow**; tick it again to jump back.
- While listening, mark a new word or passage and press **Play from here** to switch.
- **‹ / ›** (or **← / →**) while listening: back or forward one sentence. Back restarts the
  current sentence, or goes to the previous one if it has only just started.
- Reopening a PDF puts the start marker where you stopped reading; press Play to carry on.
  (Positions are kept in `settings.json`; replaying a selected passage doesn't move it.)
- Running headers and footers that repeat on every page are skipped, not read aloud.
- **Space** play/pause · **Esc** stop · **⌘O** open another PDF.

## More voices

```bash
python -m piper.download_voices                 # list all
python -m piper.download_voices en_US-ryan-high --download-dir voices
```

New voices appear in the Voice menu next time the app opens.

## Troubleshooting

Errors are written to `app.log` in this folder. Run `python app.py` from a terminal to see them live.
If you move this folder, run `./make_launcher.sh` again.
