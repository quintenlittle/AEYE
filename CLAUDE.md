# AEYE — dev notes

Local LLM chat app for Windows: FastAPI backend + vanilla-JS frontend with a
procedural ASCII eye mascot, wrapped into a native desktop window. No build
step, no framework, no telemetry. Privacy stance is deliberate: **no chat
logging by default, voice is local Piper TTS only** — keep it that way. The
one sanctioned exception is the opt-in memory feature (`memory.js`): while its
toggle is ON, chats are saved as plain local JSON under `./memory`. Memory
must stay strictly opt-in — no server-initiated chat writes, ever.

The app is otherwise fully offline: the ONLY feature that sends data off the
machine is **web access** (`web.js`), and it is OFF by default. While its toggle
is ON, the model may search the web / fetch a page and only the query or URL it
emits leaves the machine — no background calls, no query logging. Keep it opt-in
and keep the SSRF guard on `fetch_url`.

## Run / test

- `aeye.bat` — desktop app (pywebview window, the normal way users launch)
- `start.bat` — same server in the default browser instead
- Dev server on a test port (leaves a user's live 8130 instance alone):
  `.claude/launch.json` has the `aeye-test` config (port 8231), or
  `set AEYE_PORT=8231 && .venv\Scripts\python.exe server.py`
- `install.bat` — full installer (venv, deps, Ollama, shortcut). `package.bat`
  builds `dist\aeye-portable.zip` for transfer to another machine.
- No test suite; verify by driving the UI against a running server.
  `.venv\Scripts\python.exe -m py_compile server.py desktop.py` for syntax.

## Layout

- `server.py` — the entire backend: Ollama proxy + HF transformers chat,
  diffusers image gen + text-to-video gen, Piper TTS, model catalog + trending
  refresh, hardware scan. Single file by design.
- `desktop.py` — desktop entrypoint: runs the same app in a thread, opens a
  pywebview (WebView2) window.
- `static/` — one JS module per feature: `eye.js` (renderer), `chat.js`
  (chat + model dropdown), `library.js` (catalog UI), `imagine.js`,
  `dream.js` (text-to-video generation),
  `voice.js` (TTS), `stt.js` (local Whisper mic dictation),
  `sysmon.js` (meters), `game.js` (boss-fight clicker),
  `memory.js` (opt-in chat memory + projects),
  `docs.js` (local document RAG in the memory drawer),
  `web.js` (opt-in web search + page fetch tool),
  `theme.js` (themes & UI presets + custom palette),
  `skull.js` (hidden-eye skull backdrop + jaw animation),
  `plugins.js` (local-tool command plugins),
  `style.css` (phosphor CRT theme), `aeye.ico` (window/taskbar/shortcut icon).

## Architecture notes

- **Eye state machine** (`eye.js`): `EYE.setState('idle'|'thinking'|'streaming'|
  'loading'|'refreshing'|'error'|'asleep')` sets `body[data-state]`; CSS
  variables recolor the iris per state. The game's anger (`EYE.rage(ms)` +
  `body.rage` class) is a deliberate overlay, independent of the state machine
  so it can never corrupt real states. Background features must not steal the
  eye from real work (see the guards in `library.js` `updateRefreshUI`).
  The render loop is `requestAnimationFrame` (native display rate, no built-in
  cap). An optional FPS cap (`EYE.setFps`, settings > Display slider,
  `localStorage['aeye-fps']`, 15–60 where 60 = uncapped) throttles by skipping
  rAF ticks until `frameInterval` has elapsed; `eye.lastFrame` only advances on
  real paints so `dt` spans the skips and the physics stay correct. All eye
  animation is dt-based (exp smoothing + `spin`), so a lower cap keeps the same
  SPEED with fewer sample points — it's a steadiness/CPU knob, not a slowdown.
  eye.js reads the saved value at boot (before the first frame); chat.js
  `settingsToggles()` reflects it into the slider. Jitter is main-thread
  contention (a model generating parses SSE + rebuilds chat DOM per token) or
  thermal throttling, not a cap.
- **Model selection** (`chat.js`): `localStorage['aeye-model']` is the source
  of truth — every pick/pull/load saves it; last-used always wins on boot.
  `DEFAULT_MODEL` is the fresh-profile fallback. The `hfLoadRequested` flag
  exists so the startup auto-reload can never hijack the user's selection —
  only user-initiated loads auto-select on ready.
- **Startup model picker** (`startup.js` + `/api/autoload*` in `server.py`):
  models are NOT auto-loaded on boot (loading chat + image + video at once ate a
  lot of RAM). `.aeye_state.json` still remembers the last chat/image/video
  models; on boot `startup.js` calls `/api/autoload/options` (last-used model per
  category + whether still cached on disk) and, if anything is restorable, shows
  a popup to pick which to bring back. The choice hits `/api/autoload`, which
  runs the chosen `_autoreload_hf/image/video` **sequentially (never in
  parallel — parallel loads fight over VRAM and die with "cannot copy out of
  meta tensor" on 8 GB cards).** Each still loads only if its repo is cached.
  The `_offload_pipe` mode is set by `AEYE_OFFLOAD` (aeye.bat/start.bat default
  it to `none` = load straight to GPU).
- **Header badges** are always solid green (`.badge`/`.on`/`.err` all use `--fg`,
  which is theme-aware but state-stable) — deliberately no dim/grey/red state
  tinting; the badge text names the state and the eye flashes red on errors.
- **Image + video generation** (`imagine.js`/`dream.js` + the `/api/img/*` and
  `/api/vid/*` blocks in `server.py`): two parallel diffusers backends with the
  SAME shape — a lazy background load (`IMG`/`VID` state), VRAM-thrifty CPU
  offload via the shared `_offload_pipe` (default `enable_model_cpu_offload`;
  auto-escalates to the heavier submodule-granular `enable_sequential_cpu_offload`
  when the OTHER gen pipeline is already loaded on a <16GB card so both can
  coexist without OOM — `AEYE_OFFLOAD=sequential|model|none` forces it), a header
  badge (`img:`/`vid:`), and an inline
  panel that shares the chat column so the eye stays visible (only one of
  chat/imagine/dream is shown at a time; each `show*` hides the others). Image
  uses `AutoPipelineForText2Image`; **video uses `DiffusionPipeline` (auto-picks
  the pipeline class from model_index.json), with AnimateDiff special-cased**
  (a motion-adapter repo isn't a standalone pipeline: it's mounted on an SD1.5
  base — `AEYE_ANIMATEDIFF_BASE`, which `aeye.bat`/`start.bat` default to
  `emilianJR/epiCRealism` since the vanilla SD1.5 base gives mushy clips — with
  a DDIM scheduler). Image and video pipelines can BOTH be loaded at once (VRAM
  permitting — the user chose this over auto-unloading one for the other);
  auto-reload restores them sequentially (hf → image → video), each only if
  still cached, and a load that runs out of VRAM just stays idle. `_vid_generate`
  passes only the kwargs the specific pipeline's `__call__` accepts (signatures
  differ across T2V models). Output is an mp4 via diffusers `export_to_video`
  (needs `requirements-video.txt`: imageio-ffmpeg) or, if no codec backend is
  present, an animated **GIF fallback written with Pillow alone** — so video
  works even without the optional dep. The frontend picks `<video>` vs `<img>`
  from the returned `mime`. Catalog routing: `_classify` has a `video` bucket
  checked **before** `image` (a T2V repo carries the diffusers/text-to-image
  tags too, so video must win to get the `load ▸ dream` button); the harvest
  guard keeps only real diffusers T2V pipelines (drops GGUF video — sd.cpp
  quants we can't run — and non-`text-to-video` false positives). A dedicated
  refresh phase harvests trending + uncensored text-to-video so they populate
  the library like everything else, and there's a `video gen` catalog filter.
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
- **Document RAG** (`docs.js` + the `/api/docs/*` block in `server.py`):
  optional install (`requirements-rag.txt`: sentence-transformers, faiss-cpu,
  pypdf). PDF/TXT/MD/DOCX uploads (raw-body `?name=` POST — no multipart, no
  python-multipart dep) are extracted (pypdf / stdlib zip for docx), chunked
  ~800 est. tokens with ~100 overlap, and embedded on CPU
  (`AEYE_EMBED_MODEL`, default all-MiniLM-L6-v2 — downloads once, then fully
  local, mirroring the Whisper stance). Per-doc `memory/docs/vectors/<id>.npy`
  files are the persisted store; the FAISS index (numpy fallback) is rebuilt
  lazily and invalidated on add/delete, so deletes need no index surgery.
  Indexing runs in a daemon thread with progress in `/api/docs/list`
  (`_DOC_ACTIVE` stops double-requeues; interrupted docs resume on next list).
  `/api/docs/search` applies a cosine floor (`AEYE_RAG_MIN_SCORE`, 0.30) —
  weak matches are dropped, not injected. Retrieval is gated on the "use in
  chat" toggle (`localStorage['aeye-docs']`, default ON — uploading is the
  opt-in act); the injected `[DOCUMENTS]` block tells the model to prefer the
  excerpts, cite the source file, and fall back openly when they don't cover
  the question. Encoding is serialized by `_EMBED_INFER` (indexing and a live
  search can overlap on one model).
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
- **Web access** (`web.js` + the `/api/web/*` block in `server.py`): OPT-IN, OFF
  by default (`localStorage['aeye-web']`) — the ONLY feature that leaves the
  machine. Gives the chat model two live tools via a **backend-agnostic text
  protocol**, deliberately NOT native Ollama tool-calling (the HF backend has
  none, and uncensored/small Ollama models don't honor `tools` reliably): while
  the toggle is on, `web.js` `systemPrompt()` tells the model to answer a
  current-info need with ONE line of JSON —
  `{"tool":"web_search","query":...}` or `{"tool":"fetch_url","url":...}`. The
  **agentic loop lives in `chat.js` `send()`**, mirroring how docs/memory inject
  context client-side: after each stream, `WEB.detect(acc)` checks for a lone
  tool-call JSON; if found (≤ `MAX_WEB_ROUNDS` 3) it runs the tool, shows a
  collapsed activity chip (`🔎 searched` / `🌐 fetched`, reusing the `.think`
  panel), feeds the results back as a `[WEB RESULTS]` **user** message, and
  re-invokes. Tool exchanges live only in the loop's local `work` array, never
  `state.messages`, so the visible/saved transcript is just the user turn + the
  final answer. Voice is suppressed on tool-call rounds (raw JSON) and spoken
  only on the final answer. This is NOT a plugin: plugins may never fire from
  model output — web tools can precisely because they are network **reads** with
  no local exec. **Provider** (`_web_provider`): keyless DuckDuckGo by default
  (httpx POST to `html.duckduckgo.com/html/` + a stdlib `HTMLParser` scrape,
  `uddg=` redirect links decoded — no new hard dep); a `TAVILY`/`BRAVE`/`SERPAPI`
  key in env or `web_keys.txt` (loaded like `_hf_token()`) is preferred when
  present. **Auto-fetch** (`web_search` `deep`, default on): after the snippet
  list, the server auto-reads the top `_WEB_DEEP_MAX` (5) results' full pages
  **in parallel** (`asyncio.gather` over the shared `_web_fetch_page`, each
  ranked to the search query, small per-page budget/`extract_cap` so 5 pages
  stay light on weak hardware) so one search gathers data from SEVERAL sources
  at once instead of one — blocked pages (403/timeout) just drop out and the
  rest are kept in rank order. They ride back as `top_pages` (a list), and the
  client folds each in as `━━ Source A/B/C… ━━` with a footer telling the model
  to cross-check and conclude from what multiple sources agree on. The chip
  shows `📄 read N pages` and every page joins the sources footer. **Recency**:
  `web.js` `systemPrompt()` prepends the current local date/time (from
  `new Date()` — the webview IS the machine, so it's the NTP-synced system
  clock; time.gov is dead/JS-only and not fetched) so the model can tell recent
  from stale; `recencyFor()` reads the query intent (today/headlines → day,
  latest/news/price → week, this month/`<year>`/trending → month) and passes a
  `recency` window to `/api/web/search`, which maps it to each provider's
  freshness param (`_recency_param`: DDG `df`, Brave `freshness`, Tavily
  `time_range`, SerpAPI `tbs=qdr:`). Evergreen queries get no filter. **`fetch_url`** extracts readable text via `trafilatura` if installed
  (`requirements-web.txt`, optional) else a stdlib tag-stripper. It then
  **relevance-ranks** the page against the user's question (`_web_rank`, run off
  the event loop): the page is chunked with the docs-RAG chunker (`_chunk_units`)
  and scored by the same local embedder (`_embed_load` + `_EMBED_INFER`), so a
  long page is distilled to the slices that answer the question instead of a
  blind head-truncation — degrades to a head slice when RAG isn't installed. The
  client forwards the user's message as the ranking `query`; `web_fetch` returns
  a `ranked` flag the chip surfaces. **SSRF guard** (`_web_safe_url`): http/https only, every resolved
  address must be public (loopback/private/link-local/reserved rejected), and
  redirects are followed MANUALLY re-validating each hop — so the model can't
  make the server probe `localhost`/the Ollama port/LAN/cloud-metadata. All
  network paths are best-effort: a failure returns a `[WEB RESULTS] (no results)`
  message so the model answers from knowledge instead of looping. **Tool-call
  detection** (`web.js` `detect`) is deliberately lenient for weak/uncensored
  models: bare JSON, ```json fences, `<tool_call>`/`<function>` XML wrappers, the
  OpenAI `{name,arguments}` shape, and bare `web_search("…")` function syntax all
  parse; the system prompt carries a couple of few-shot examples. **Sources
  footer**: `chat.js` collects the URLs each round drew on and renders a
  deduped, clickable `.sources` list under the final answer; a click hits
  `/api/open` (relaxed from HF/Ollama-only to any **http/https** URL) to open it
  in the system browser, since the webview has no tabs. **Fabrication guard**
  (`WEB.looksFaked` + `chatQuestion`): small models sometimes role-play the
  wrapper — writing their own `[WEB RESULTS] …` and hallucinating instead of
  emitting a real tool call. Since that marker only ever appears in messages WE
  inject, a reply opening with it is caught, the bubble is dropped, and an
  in-chat **question card** (clickable options, resolves a Promise) asks the user
  whether to retry with a real search, answer from the model's own knowledge, or
  stop — each path appends a corrective `[SYSTEM]` nudge and re-runs the loop.
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
  fixes the title bar). `text_select=True` — pywebview blocks highlighting
  by default; needed so chat text is copyable (plus `user-select:text` in CSS).
  Root `AEYE.ico` is the icon source; `static/aeye.ico` is the multi-size build
  used for window/taskbar/shortcut, packaged with the root copy.
- **Themes & UI** (`theme.js` + the preset blocks at the top of `style.css`):
  presets dark/light/oled/high-contrast switch `data-theme` on `<html>`;
  dark IS the bare `:root` palette. A custom theme is four colors
  (primary/accent/bg/text) expanded by `buildVars()` into the full variable
  set and applied as inline styles on `<html>` (inline beats every preset
  block). ALL themable colors are CSS variables — the old hardcoded dark
  hexes (#0d1810 etc.) became `--hover/--row-line/--well/--user-line/
  --overlay`; never reintroduce literals for UI surfaces. Persisted in
  localStorage: `aeye-theme`, `aeye-theme-custom` (the 4 colors),
  `aeye-theme-vars` (computed map replayed by the inline snippet at the top
  of `index.html` BEFORE first paint — keep that snippet or themed boots
  flash green). Text/accent are contrast-guarded (WCAG 4.5:1 / 3:1) toward
  black/white. Eye-state colors live on `body[data-state]` so they override
  any theme (light gets its own darker state set in style.css); `body.rage`
  and the game's palette are deliberately untouched.
- **Skull backdrop** (`skull.js` + `/api/skull` in `server.py`): with the eye
  hidden, root `skull.txt` (also the installer banner — one canonical file,
  served no-cache) renders dim (`--sclera` at .13) behind the chat via a
  negative-z-index layer in `#chat-panel`. While `body.eye-hidden` is set
  AND (`body[data-state]` is `streaming` OR `VOICE.speakingReply()` — the
  jaw keeps chattering until Piper's queue drains), the mandible drops in a
  choppy 4-step loop at ~8 fps — thinking/reasoning stays static by design.
  The jaw is a SHAPED region, not a row slice: lines 21+ minus the `MOUTH`
  column spans (the mouth-interior runs inside the mandible's U, which stay
  with the static skull), so the seam follows the bone's curved outline —
  the user explicitly rejected straight horizontal splits. All jaw cells
  move with one identical offset (rigid hinge); the 3 frames are
  pre-rendered strings built once from a cell grid (strip `\r` — skull.txt
  is CRLF and stray CRs become invisible jaw cells), each tick is a pure
  `textContent` swap. Sclera-colored at .3 opacity. Event-driven via a
  MutationObserver on body attributes; no attribute flips when the voice
  drains, so each tick re-checks `active()` and the loop kills itself. The
  interval exists only while animating (zero idle timers) and only the jaw
  `<span>` is retextured; in eye-hidden mode chat bubbles drop their
  backgrounds (`body.eye-hidden .msg.*` → transparent) so the skull stays
  visible through the conversation; frames pad with single-space lines so the
  `<pre>` height never changes (no layout shift — bare trailing newlines
  would collapse). Deliberately no glow/transitions; failures degrade to a
  static skull or an empty layer, never an error.
- **Plugins** (`plugins.js` + the `/api/plugins/*` block in `server.py`): run a
  local tool dropped into `./plugins/<id>/` with an `aeye-plugin.json` manifest
  (`name`, `trigger`, `command:[argv]`, `cwd?`, `timeout?`). A chat message
  STARTING with a trigger (boundary-checked; longest trigger wins) runs the
  tool; `{query}` (text after the trigger) is substituted into argv items and
  streamed to `/api/plugins/run`, whose stdout+stderr come back as SSE lines
  rendered in a chat bubble. **Safety boundary: plugins fire ONLY from the
  composer submit in `chat.js` — never from model output, memory or docs — so a
  model can't emit a phrase that executes a local command.** The query is passed
  as ONE argv item (no `shell=True`, no splitting → no arg/command injection);
  the plugin id is regex-validated and confined to `./plugins` (realpath +
  commonpath, so no traversal, and cwd can't escape). Output is NOT pushed into
  `state.messages` or memory. Arbitrary local execution is the point, so the
  guardrails make it deliberate/un-hijackable, not sandboxed — the manage
  `plugins` tab shows each plugin's exact argv before you run it. A broken
  manifest surfaces as a per-row `error` instead of hiding the other plugins.
  `chat.js` exposes `CHAT.pluginExec(commandText, runner)` (busy-lock + user
  bubble + assistant bubble to stream into). Bundled `plugins/echo/` is a
  working sample; `plugins/` ships via `package.bat`.
  **Dependencies** (`/api/plugins/install`, the plugins-tab "install deps"
  button): creates an ISOLATED per-plugin venv (`plugins/<id>/.venv`) and
  `pip install -r requirements.txt` into it, streamed to `#plug-log` — a
  tool's packages never collide with AEYE's own env or another plugin's. The
  runner auto-swaps a `python`/`python3` command[0] for that venv's python via
  `_plugin_venv_python` when it exists (else system `python`, so the depless
  echo sample still works). `_plugin_load` reports `requirements` (detected
  file) + `installed` (venv present). requirements filename is basename-only
  (no path escape); install/venv-create use `sys.executable`. Button-triggered
  only — installing runs the packages' build hooks (same trust as running the
  tool). Note: a built package after installs will contain plugin `.venv`s.
  **Modes** (manifest `mode`, default `stream`): `stream` = run to completion,
  stdout→chat bubble (the original). `terminal` = `/api/plugins/launch` fires
  the tool in its OWN console window (`CREATE_NEW_CONSOLE`/`NEWCONSOLE`,
  fire-and-forget, Windows only) for full-TUI/interactive tools — output stays
  in that window. `interactive` = a live stdin/stdout SESSION in chat
  (`/api/plugins/interactive/{start,stream,input,stop}`): a `_PlugSession`
  keeps the proc alive, a daemon thread reads stdout as raw bytes (so a
  no-newline prompt still surfaces; `PYTHONUNBUFFERED` set) into a queue, the
  stream SSE drains it; each composer line is routed to stdin. chat.js submit
  checks `PLUGINS.sessionActive()` FIRST (before match/send) so the composer
  feeds the tool while a session runs; `/exit` or `/stop` (or the proc exiting,
  or the SSE closing) ends it, restoring the composer. Sessions capped
  (`_PLUGIN_SESS_MAX` 4) with a `_PLUGIN_SESS_TTL` lifetime; pagehide beacons a
  stop. `_plugin_prepare()` is the shared argv builder (query substitution +
  venv-python swap + cwd confinement) used by run/launch/interactive.
  **Removal** (`/api/plugins/delete`, per-row trashcan): fully deletes the
  `plugins/<id>` folder incl. its `.venv` via `_plugin_rmtree` (clears Windows
  read-only bits on a retry — pip leaves some). id confined by `_plugin_dir`.
  The trashcan is a two-click confirm (🗑 → "sure?" → delete, auto-reverts
  after 3 s) so no reliance on a webview `confirm()` dialog.
  **Clone from GitHub** (`/api/plugins/clone`, the plugins-tab URL field):
  streamed `git clone --depth 1 -- <url> <dest>` into `plugins/<id>` (id
  derived from the repo name). URL is validated against `_GH_RE` (https
  github.com owner/repo only) and rebuilt from the parsed owner/repo, `--`
  guards option injection, `GIT_TERMINAL_PROMPT=0` prevents credential-prompt
  hangs, partial clones are cleaned up on failure. Cloning runs no repo code
  (git doesn't run a cloned repo's hooks) — execution stays behind
  install/run. If the repo lacks a manifest, `_plugin_scaffold_manifest`
  writes a starter one (guessing a Python entry point) and the UI auto-opens
  the inline manifest editor. **Manifest editor** (`/api/plugins/manifest`
  GET/POST + the `edit` row button): reads/writes `aeye-plugin.json`,
  validating it parses as a JSON object before writing (atomic tmp+replace).
- **Settings** (manage modal `settings` tab, wired in `chat.js`
  `settingsToggles()`): `hide-eye` calls `EYE.setHidden()` — flips
  `body.eye-hidden` (CSS drops `#eye-panel`, chat fills the width) and PAUSES
  the eye's rAF loop (`eye.hidden`/`eye.rafPending`) to save GPU. The eye is
  hidden when the checkbox is on (`aeye-hide-eye`) OR the viewport is narrower
  than `EYE_AUTOHIDE_W` (1080 px) — a `resize` listener recomputes
  `manual() || tooNarrow()`, so a small window auto-hides the ~600px eye panel
  and widening brings it back (the auto rule never overwrites the saved
  preference). The header is a `flex-direction:column` stack of THREE centered
  tiers, top to bottom: `#knobs` (temp/modelfile/create/max/ctx/clear + the
  `#sysmon` meters + `#clock`), `#badges` (ollama/hf/img/hardware — split out of
  `#model-bar`), then `#model-bar` (model dropdown + refresh + manage/library/
  imagine/memory). Each tier is full-width with `justify-content:center` +
  `flex-wrap`, so content centers and wraps at any width. There is no `#logo`
  (removed by request).
  `remember
  system prompt` persists `#system-prompt` to `aeye-sysprompt` while on.
  CPU temp reads the perf-counter thermal zone first (the MSAcpi class is
  often stuck — 77 C forever here); GPU temp via nvidia-smi.
- **HWiNFO sensor bridge** (`_hwinfo_*` in `server.py` + the meters in
  `sysmon.js`): when HWiNFO64 runs with "Shared Memory Support" enabled, a
  daemon thread parses its SM2 shared-memory block (ctypes + struct, no deps;
  registry "Gadget" mirror `HKCU\Software\HWiNFO64\VSB` as fallback — the
  free build kills shared memory after 12 h). Merge rule in `_sys_stats`:
  HWiNFO **overrides temps** (real die/junction sensors beat the WMI zone;
  label heuristics prefer Tctl/Tdie / CPU Package and skip "hot spot") and
  only **fills gaps** for usage/net (psutil + nvidia-smi keep those when they
  answer — nvidia-smi's exact GB feed the VRAM tooltip; HWiNFO covers
  AMD/Intel GPUs and the no-psutil case). Adds `vram_temp` (memory junction)
  — the VRAM gauge grew a thermometer that hides when there's no reading —
  and sets `hwinfo:true`, which the tooltips show as "· HWiNFO". While HWiNFO
  covers cpu_temp the PowerShell WMI loop skips its spawn. Poll is 2 s when
  live, 10 s backoff when HWiNFO is absent (so launching it later just
  works); everything degrades to the old paths when it exits.
  Note: the header's on-screen temperature **thermometers were removed**
  (`sysmon.js` `defs` dropped `therm`) to make room for the `#clock` (local
  date/time, ticks each second) at the far right of `#knobs`; the meters show
  usage bars only. Temps still poll server-side and appear in each gauge's
  hover tooltip.
- **Game maxed-out eyes** track the cursor GLOBALLY (`window` pointermove
  updating `aim`), matching the big eye. Chat images: click toggles
  `.expanded` (capped `min(80vw,900px)`, `!important` to beat the thumbnail
  cap); no zoom cursor.
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
