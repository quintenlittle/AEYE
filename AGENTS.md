# AEYE — dev notes

Local LLM chat app for Windows: FastAPI backend + vanilla-JS frontend with a
procedural ASCII eye mascot, wrapped into a native desktop window. No build
step, no framework, no telemetry. Privacy stance is deliberate: **no chat
logging by default, voice is local Piper TTS only** — keep it that way. The
one sanctioned exception is the opt-in memory feature (`memory.js`): while its
toggle is ON, chats are saved as plain local JSON under `./memory`. Memory
must stay strictly opt-in — no server-initiated chat writes, ever.

## Run / test

- `aeye.bat` — desktop app (pywebview window, the normal way users launch)
- `start.bat` — same server in the default browser instead
- Dev server on a test port (leaves a user's live 8130 instance alone):
  `.Codex/launch.json` has the `aeye-test` config (port 8231), or
  `set AEYE_PORT=8231 && .venv\Scripts\python.exe server.py`
- `install.bat` — full installer (venv, deps, Ollama, shortcut). `package.bat`
  builds `dist\aeye-portable.zip` for transfer to another machine.
- No test suite; verify by driving the UI against a running server.
  `.venv\Scripts\python.exe -m py_compile server.py desktop.py` for syntax.

## Layout

- `server.py` — the entire backend: Ollama proxy + HF transformers chat,
  diffusers image gen, Piper TTS, model catalog + trending refresh, hardware
  scan. Single file by design.
- `desktop.py` — desktop entrypoint: runs the same app in a thread, opens a
  pywebview (WebView2) window.
- `static/` — one JS module per feature: `eye.js` (renderer), `chat.js`
  (chat + model dropdown), `library.js` (catalog UI), `imagine.js`,
  `voice.js` (TTS), `stt.js` (local Whisper mic dictation),
  `sysmon.js` (meters), `game.js` (boss-fight clicker),
  `memory.js` (opt-in chat memory + projects),
  `style.css` (phosphor CRT theme), `aeye.ico` (window/taskbar/shortcut icon).

## Architecture notes

- **Eye state machine** (`eye.js`): `EYE.setState('idle'|'thinking'|'streaming'|
  'loading'|'refreshing'|'error'|'asleep')` sets `body[data-state]`; CSS
  variables recolor the iris per state. The game's anger (`EYE.rage(ms)` +
  `body.rage` class) is a deliberate overlay, independent of the state machine
  so it can never corrupt real states. Background features must not steal the
  eye from real work (see the guards in `library.js` `updateRefreshUI`).
- **Model selection** (`chat.js`): `localStorage['aeye-model']` is the source
  of truth — every pick/pull/load saves it; last-used always wins on boot.
  `DEFAULT_MODEL` is the fresh-profile fallback. The `hfLoadRequested` flag
  exists so the startup auto-reload can never hijack the user's selection —
  only user-initiated loads auto-select on ready.
- **Startup auto-reload** (`server.py`): `.aeye_state.json` remembers the last
  chat + image models; `_autoreload_models()` restores them **sequentially —
  parallel loads fight over VRAM and die with "cannot copy out of meta
  tensor" on 8 GB cards. Never parallelize model loads.**
- **Chat memory** (`memory.js` + the `/api/memory/*` block in `server.py`):
  OFF by default (`localStorage['aeye-memory']`); while off the frontend never
  calls the save endpoints, so nothing touches disk. While on: each finished
  exchange appends to `memory/chats/<id>.json` (system messages and image
  payloads are stripped server-side, so injected memory context never re-saves
  itself). On exit/clear a model-written **briefing** (`summary` +
  `summary_upto`) is stored via `/api/memory/summarize` — sendBeacon on
  `pagehide`, which the desktop's `os._exit(0)` can cut short, so `resume()`
  lazily regenerates any stale briefing before folding history. Resuming sends
  briefing + last `TAIL` (12) raw messages, never the full transcript; only
  messages past the resume point are appended back. Context injection modes:
  a selected project's briefings always ride along (and new chats auto-join
  the project); "automatic" injects only on word-overlap topic match (≥3
  tokens). Projects live in `memory/projects.json`; deleting a project only
  unassigns its chats.
- **Catalog refresh** (`server.py`): 5 phases harvesting trending models; the
  last enriches unknown sizes (thread pool) — HF repos from safetensors totals
  / GGUF file trees, and Ollama-library models from the registry manifest's
  `:latest` model-layer size
  (`registry.ollama.ai/v2/library/<n>/manifests/latest`). Ollama params are
  size-derived so they show a `~` prefix. A 30 s stall watchdog finalizes
  partial results. The eye turns violet while it runs.
- **Model page links** (`library.js` `hfPageUrl`/`modelPageUrl`): a real HF
  repo is `owner/name` — a bare token like the Ollama-native `repo:"llama3"`
  must NOT be treated as HF; require a `/` before building a huggingface.co
  URL, else it links to `ollama.com/library/<name>` correctly.
- **Speech-to-text** (`stt.js` + `/api/stt*` in `server.py`): LOCAL Whisper via
  `faster-whisper`, optional install (`requirements-stt.txt`). The mic records
  webm/opus (timeslice 250 ms), POSTs the blob to `/api/stt`; PyAV decodes it,
  the model (lazy-loaded, CPU int8, `AEYE_WHISPER_MODEL` default `base`)
  transcribes. 100% on-device — mirrors the Piper stance. **Live dictation**:
  while recording, the audio-so-far is re-transcribed ~every 1.1 s and shown in
  the composer via `CHAT.dictate(text, live)` (the `#input.dictating` red glow);
  `finalize()` does the authoritative pass. With **auto-send** on, a Web Audio
  RMS VAD auto-stops on ~2 s silence or ~7 s total, then `CHAT.submit()`s;
  otherwise click the mic to stop. Overlapping interim+final calls are
  serialized server-side by `_WHISPER_INFER` (faster-whisper isn't concurrency-
  safe on one model). Mic disables itself if not installed. This is the ONE
  sanctioned exception to "no STT" — local, unlike the removed browser mic.
- **Desktop window** (`desktop.py`): `private_mode=False` + `.webview` dir =
  persistent localStorage; `?boot=<epoch>` URL busts the cached page;
  `os._exit(0)` on close frees port/VRAM instantly; a port-free wait stops
  fast relaunches from attaching to a dying instance; DWM calls paint the
  title bar black and set the icon. `_set_app_id()` sets an explicit
  AppUserModelID — WITHOUT it the taskbar groups under `pythonw.exe` and
  shows its generic Python icon instead of the eye (WM_SETICON alone only
  fixes the title bar).
- **Game** (`game.js`): session-only score (resets on reboot, by request).
  Laser levels every 100 damage, LV1..100: click damage = LV (even,
  incremental — user request), beam colour/width sweep the classic bands
  smoothly, twin beams at LV50+, wobble at LV80+; at LV100 bolts cycle
  rainbow hues and the LV readout glows RGB (per-digit hue offsets, animated
  by a 120 ms interval that is gated on `document.hidden` — headless panes
  report hidden, so it looks frozen there; event-driven redraws still cycle).
  Purchasable auto-firing Galaga ships, eye retaliation, spoken taunts
  (`TAUNTS` list — user-approved wording), 15% shield blocks that deflect
  the bolt back at the shooter (crits pierce), ambient flak bursts,
  point-blank shots get a min beam length so clicking ON the eye always
  shows a bolt (eye.js's old click-to-blink was removed for this). Shop row:
  LASER (powers the FLEET's guns, x1→x10 multiplier on ship damage, cost x2
  each, rainbow ship bolts at x10 — it does NOT boost the player's laser;
  only damage levels do), SHIP (flat 100, cap 100 — they get shot down),
  RAPID (hold-to-fire machine gun that tracks the cursor, 8/12/16 shots/s,
  cost x3, cap 3). Retaliation is damage-paced AND time-limited (4-8 s
  between shots) — without the time floor a maxed fleet's damage rate made
  the eye wipe all 100 ships in seconds. RGB-glow readouts (shared
  `drawGlowText`): LV at 100, SCORE at the 9,999,999 display cap, X (ship
  count) at the 100-ship cap. Easter eggs: each MILLION crossed on SCORE
  shatters the eye into five canvas-drawn mini eyes (`swarm` class on the
  panel hides the pre) that orbit against the fleet's majority direction for
  22 s, then fuse back; at the 9,999,999 SCORE cap the swarm becomes
  PERMANENT (until the app exits; spending below the cap does NOT undo it):
  the LEGION — the same canvas vector eyes but bigger and slow-spinning,
  each riding its own point on the colour wheel (`legionHue`, 72° apart, the
  star 36° off so the whole spectrum is always covered), joined into a
  pentagram whose points ARE the eye centres (so it rotates with them; no
  bob in permanent mode or the lines would bend); on arrival the eye SPEAKS
  its monologue (`legionSpeak` -> `VOICE.speakLong(LEGION_SPEECH)`, streamed
  sentence-by-sentence in the currently selected Piper voice/effect, forced on
  regardless of the mute toggle -- user-supplied text; replaced the old
  `legionSound` drone, which stays defined but unused), plus a `legion` class
  on the panel that hue-rotates `#eye-status` + `.taunt-line` until reboot (a
  CRT flicker was tried and removed by request — keep them solid). An
  earlier build mirrored pre#eye
  into five DOM `<pre>` clones — text-shadow on hundreds of glowing spans
  ×5 at 25 fps melted the GPU; keep the final form on canvas. The ring
  orbits OUTSIDE the fleet's lanes so ships never clip the eyes. Temporary
  swarm defers to real work: only triggers when `body[data-state]` is idle
  + tab visible, reforms early on a state change; the permanent one
  persists. Phase flips are on timers; all swarm drawing is rAF. Firing is on `pointerdown` (not click)
  across the whole panel; the shop row stopPropagation's pointerdown so
  buying never shoots. Game logic runs on timers, not rAF, so
  hidden/throttled tabs don't drop hits; only drawing lives in the rAF loop.
  Taunts are TIME-gated (first at 100 damage, then one per 3-5 min while
  under attack) and
  cycle the TAUNTS list IN ORDER (`tauntIdx`) — never randomize, repeats
  break immersion (user request). They speak whenever
  `VOICE.speakingReply()` is false — busy states (thinking/image gen) do NOT
  mute them; only an actually-spoken chat reply does. The eye grid has NO
  background dots (removed by request — ambience is game.js flak only).

## Gotchas (each of these caused a real bug)

- **WebView2 caches per origin and serves stale JS after updates.** The server
  sends `Cache-Control: no-cache` on `/` and `/static` — don't remove it.
  Asset URLs carry `?v=N`; bump only if the no-cache path is ever bypassed.
- **Batch files: an unescaped `)` inside an `if (...) else (...)` block kills
  the whole script** ("syntax incorrect", installer dies mid-run). Escape as
  `^)` in every `echo` inside parens. Test installers by piping `choice`
  answers through them.
- **Eye renderer NaN poisoning**: any frame where the eye pane has zero width
  while the mouse moved recently used to set `eye.look` to NaN forever (that
  is how the desktop window's load-time layout broke the pupil). The guards
  in `frame()` (`rect.width > 0`, `Number.isFinite` reset) must stay.
- `package.bat` has an **explicit top-level file list** — a new root-level
  file must be added there; anything inside `static/` is included wholesale.
- localStorage keys are `aeye-*`; `index.html` has a one-time `oculus-*`
  migration shim plus a one-time default-model seed (`aeye-default-v2`).
- HF token: env `HF_TOKEN` or `hf_token.txt` (never packaged).
- The Windows title bar styling and `maximized=True` live in `desktop.py`;
  the icon is multi-size `static/aeye.ico` (16→256, user-supplied artwork).
