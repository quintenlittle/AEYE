#!/usr/bin/env python3
"""
skulltalk -- an ultra-minimal, 100% terminal AEYE.

A dim ASCII skull sits in the terminal; when it speaks, its jaw drops in the
same choppy closed->ajar->open->ajar loop as AEYE's hidden-eye backdrop
(skull.js), driven for exactly as long as the Piper voice is talking. Voice is
local Piper danny-low, run through the "dalek" horror chain, at rate 0.85 --
AEYE's own default. No server, no browser, no window. Just the terminal.

Usage:
    python skulltalk.py                 # REPL: type a line, the skull says it
    python skulltalk.py "hello there"   # one-shot: speak the argument and exit
    echo "text" | python skulltalk.py   # speak piped stdin and exit
"""

import io
import os
import sys
import time
import wave
import tempfile
import winsound

# --- config: AEYE's shipped voice defaults --------------------------------
VOICE_KEY = "en_US-danny-low"
VOICE_PATH = "en/en_US/danny/low"        # folder inside rhasspy/piper-voices
RATE = 0.85                              # length_scale = 1 / rate (higher=faster)
# the "dalek" horror preset, verbatim from server.py HORROR_EFFECTS
DALEK = {"pitch": -3, "ring": 50, "ring_mix": 0.65, "drive": 6,
         "reverb": 0.15, "wet": 0.2, "ls": 1.06}
LEAD_MS, TAIL_MS = 200, 250              # silence pad so playback never clips

# --- jaw animation: identical constants to static/skull.js ----------------
JAW_AT = 20                              # 0-based line where the mandible begins
DROP = 2                                 # rows the jaw falls at full gape
SEQ = [0, 1, 2, 1]                       # closed -> ajar -> open -> ajar (loops)
MS = 125                                 # ~8 fps -- choppy on purpose
MOUTH = {0: (20, 35), 1: (19, 35), 2: (19, 36)}   # static mouth-interior spans

HOME = "\033[H"                          # cursor to top-left
HIDE, SHOW = "\033[?25l", "\033[?25h"    # hide / show cursor
DIM, RESET = "\033[2;37m", "\033[0m"     # dim grey -- the "behind the chat" look


# ==========================================================================
# Skull frame builder -- a direct port of skull.js build()
# ==========================================================================
def build_frames(text):
    """Return (title-less) list of 3 full skull strings: jaw at drop 0, 1, 2."""
    lines = text.replace("\r", "").rstrip().split("\n")
    if len(lines) <= JAW_AT:
        raise ValueError("skull too short")
    W = max(len(l) for l in lines)
    cranium = "\n".join(lines[:JAW_AT])          # static upper skull

    lower = [list(l.ljust(W)) for l in lines[JAW_AT:]]
    statics = [[" "] * W for _ in range(len(lower) + DROP)]
    jaw = []                                     # [(row, col, char)]
    for r, cells in enumerate(lower):
        m = MOUTH.get(r)
        for c, ch in enumerate(cells):
            if ch == " ":
                continue
            if m and m[0] <= c < m[1]:
                statics[r][c] = ch               # mouth interior: stays put
            else:
                jaw.append((r, c, ch))            # everything else drops

    frames = []
    for k in range(DROP + 1):
        g = [row[:] for row in statics]
        for r, c, ch in jaw:
            g[r + k][c] = ch
        lower_str = "\n".join("".join(row).rstrip() for row in g)
        frames.append(cranium + "\n" + lower_str)
    return frames


# ==========================================================================
# Piper synthesis + the dalek chain -- ported from server.py _piper_synth
# ==========================================================================
_VOICE = None


def _piper():
    global _VOICE
    if _VOICE is None:
        from piper import PiperVoice
        from huggingface_hub import hf_hub_download
        onnx = hf_hub_download("rhasspy/piper-voices",
                               f"{VOICE_PATH}/{VOICE_KEY}.onnx", local_files_only=True)
        hf_hub_download("rhasspy/piper-voices",
                        f"{VOICE_PATH}/{VOICE_KEY}.onnx.json", local_files_only=True)
        _VOICE = PiperVoice.load(onnx, onnx + ".json")
    return _VOICE


def _wav_to_np(wav_bytes):
    import numpy as np
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
        frames = w.readframes(w.getnframes())
    dtype = {1: np.int8, 2: np.int16, 4: np.int32}.get(sw, np.int16)
    arr = np.frombuffer(frames, dtype=dtype).astype(np.float32) / float(np.iinfo(dtype).max)
    if ch > 1:
        arr = arr.reshape(-1, ch).mean(axis=1)
    return arr, sr


def _np_to_wav(samples, sr):
    import numpy as np
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _pad(wav_bytes):
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        n, ch, sw, fr = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
        frames = w.readframes(n)
    sil = lambda ms: b"\x00" * (int(fr * ms / 1000) * ch * sw)
    out = io.BytesIO()
    with wave.open(out, "wb") as w:
        w.setnchannels(ch); w.setsampwidth(sw); w.setframerate(fr)
        w.writeframes(sil(LEAD_MS) + frames + sil(TAIL_MS))
    return out.getvalue()


def _dalek(wav_bytes):
    """Run a Piper WAV through the dalek pedalboard chain -> WAV bytes."""
    import numpy as np
    from pedalboard import Distortion, Pedalboard, PitchShift, Reverb
    x, sr = _wav_to_np(wav_bytes)
    # ring modulation -> corrupted-machine / Dalek buzz
    t = np.arange(len(x), dtype=np.float32) / sr
    carrier = np.sin(2.0 * np.pi * DALEK["ring"] * t).astype(np.float32)
    rm = DALEK["ring_mix"]
    x = (1.0 - rm) * x + rm * (x * carrier)
    chain = Pedalboard([
        PitchShift(semitones=float(DALEK["pitch"])),
        Distortion(drive_db=float(DALEK["drive"])),
        Reverb(room_size=float(DALEK["reverb"]),
               wet_level=float(DALEK["wet"]), dry_level=1.0 - float(DALEK["wet"])),
    ])
    out = chain(x.astype(np.float32), sr)
    peak = float(np.max(np.abs(out))) or 1.0
    if peak > 1.0:
        out = out / peak * 0.98
    return _np_to_wav(out, sr)


def synth(text):
    """Speak `text` -> (wav_bytes, duration_seconds)."""
    from piper import SynthesisConfig
    text = text.strip()
    if text and text[-1].isalnum():
        text += "."                                  # let Piper finish the word
    length_scale = (1.0 / RATE) * DALEK["ls"]
    buf = io.BytesIO()
    wf = wave.open(buf, "wb")
    _piper().synthesize_wav(text, wf, syn_config=SynthesisConfig(length_scale=length_scale))
    wf.close()
    wav = _dalek(_pad(buf.getvalue()))
    with wave.open(io.BytesIO(wav), "rb") as w:
        dur = w.getnframes() / float(w.getframerate())
    return wav, dur


# ==========================================================================
# Terminal render + speak loop
# ==========================================================================
def draw(frame, title=""):
    sys.stdout.write(HOME + DIM + (title + "\n" if title else "") + frame + RESET)
    sys.stdout.flush()


def speak(frames, text):
    """Synthesize, then animate the jaw for exactly the audio's duration."""
    draw(frames[0], "  ...")
    wav, dur = synth(text)

    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    with open(path, "wb") as f:
        f.write(wav)
    try:
        winsound.PlaySound(path, winsound.SND_FILENAME | winsound.SND_ASYNC)
        start, step = time.time(), 0
        draw(frames[SEQ[0]], "  ▶ speaking")
        while time.time() - start < dur:
            time.sleep(MS / 1000.0)
            step = (step + 1) % len(SEQ)
            draw(frames[SEQ[step]], "  ▶ speaking")
    finally:
        winsound.PlaySound(None, 0)                  # stop playback
        try:
            os.remove(path)
        except OSError:
            pass
    draw(frames[0], "  ■ idle")                  # jaw shut


def enable_vt():
    """Turn on ANSI escape handling + UTF-8 output in the Windows console."""
    try:
        import ctypes
        k = ctypes.windll.kernel32
        k.SetConsoleMode(k.GetStdHandle(-11), 7)     # ENABLE_VIRTUAL_TERMINAL_PROCESSING
    except Exception:
        pass
    try:
        sys.stdout.reconfigure(encoding="utf-8")     # skull + glyphs are non-cp1252
    except Exception:
        pass


def main():
    enable_vt()
    with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "skull.txt"),
              encoding="utf-8") as f:
        frames = build_frames(f.read())

    # one-shot: argv text, or piped stdin
    oneshot = " ".join(sys.argv[1:]).strip()
    if not oneshot and not sys.stdin.isatty():
        oneshot = sys.stdin.read().strip()

    sys.stdout.write("\033[2J" + HIDE)               # clear screen, hide cursor
    try:
        if oneshot:
            speak(frames, oneshot)
            return
        draw(frames[0], "  ■ idle")
        sys.stdout.write(SHOW)
        while True:
            try:
                sys.stdout.write("\033[u")           # (restore) -- prompt below skull
                line = input("\n  say> ").strip()
            except (EOFError, KeyboardInterrupt):
                break
            if line.lower() in ("/exit", "/quit", "quit", "exit"):
                break
            if not line:
                continue
            sys.stdout.write(HIDE)
            speak(frames, line)
            sys.stdout.write(SHOW)
    finally:
        sys.stdout.write(SHOW + RESET + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
