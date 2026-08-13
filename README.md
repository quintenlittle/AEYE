# ◉ AEYE — the all-seeing local LLM container

https://github.com/user-attachments/assets/c2d75a88-d99f-4adc-b67c-c122bc038fc1

**A local LLM container for Windows, designed with privacy and security in
mind.** Chat with any Ollama or HuggingFace model, generate **images and video**,
talk to it and have it talk back — all **100% on your machine**, with nothing
phoning home by default. The whole interface is **100% hackable** (plain
HTML/CSS/JS you can rewrite) and extendable with **custom plugins**. Over it all,
a procedurally-rendered ASCII **eye follows your mouse cursor** — it watches,
thinks, speaks, and gets pretty unpredictable when you click on it.

**Runs on modest hardware, too:** nothing auto-loads at boot, every model is
tagged for *your* GPU/RAM (with CPU-only picks), and the GPU-hungry extras — the
animated eye, the scrolling tickers — can be frame-capped or hidden entirely.

> **▶ [Download the latest installer](https://github.com/quintenlittle/aeye/releases/latest)** — Windows 10/11 · one guided setup · ~73 MB

> ⚠️ **Unsigned build.** AEYE isn't code-signed yet, so the first launch shows a one-time
> Windows **SmartScreen** prompt — click **More info → Run anyway**.
> You can verify the download's **SHA-256** against the value on the
> [release page](https://github.com/quintenlittle/aeye/releases/latest). If Defender
> false-flags the installer (common for unsigned apps), restore that one file from Windows
> Security → **Protection history**.
> Alternatively, you can just temporarily disable Windows Defender and re-enable everything after the installation finishes.

<img width="870" height="1807" alt="Instructions" src="https://github.com/user-attachments/assets/bd94143d-beb3-4e33-8e73-a3ffb57893a4" />

## Install

Download and run the latest **[`aeye-setup-v*.exe`](https://github.com/quintenlittle/aeye/releases/latest)** — one guided installer that
sets everything up in a single pass:

1. The **app and its bundled Python runtime** — nothing to install just to *run* it
2. The **Microsoft WebView2 runtime** — installed silently if it's missing
3. **Ollama** and the default chat model (dolphin-mistral, ~4 GB), so the first
   launch is ready to talk
4. Optional **AI extras** you tick during setup — PyTorch + transformers +
   diffusers (**image *and* video generation**), Whisper (speech-to-text) and
   document RAG
5. A default **Piper** neural voice for text-to-speech
6. **Start-menu and Desktop shortcuts** (with the eye icon)

Launch **AEYE** from the Start menu or Desktop — it opens **maximized as a single
desktop window** (server embedded, black title bar, no browser needed).

Your data — model metadata, opt-in memory, plugins, tokens and settings — lives in
**`%APPDATA%\AEYE`** and is **never touched by an upgrade**: run a newer
`aeye-setup` straight over the top and everything carries across. Uninstalling
(via *Add or Remove Programs*) offers to keep or purge that folder.

### Moving AEYE to another machine

Run the same **`aeye-setup`** installer on the new PC. Models aren't bundled —
HuggingFace models re-download into the new machine's cache and Ollama models
re-pull from the library drawer. To bring your chats, plugins and settings along,
copy your **`%APPDATA%\AEYE`** folder across.

### The desktop window

- Starts **maximized**; the title bar and border are painted in the app's own
  near-black, with the pixel-art eye as the window/taskbar icon.
- Closing the window kills the server **instantly** (no lingering process, port
  or VRAM), so relaunches are immediate.
- Settings (selected model, TTS prefs) persist in a local `.webview` profile
  next to the app.
- On startup AEYE **auto-reloads the last chat + image models** (if still on
  disk) and kicks a trending-library scan — the eye sweeps violet while it
  scans, amber while weights load.

## The eye

The eye is not an animation — it's a 78×30 character grid recomputed every
frame (almond aperture, shaded sclera, striated iris, pupil, dual glints,
eyelids), which is what lets it move smoothly. It:

- **tracks your mouse cursor** anywhere in the window
- **wanders on its own** when your mouse goes quiet
- **blinks** at random (click it to force a blink)
- **dilates** when your cursor gets close
- **turns amber and spins its iris** while a model thinks or weights load
- **turns violet with a lazy spin** while scanning the hubs for trending models
- **turns green and shimmers** while streaming tokens, glancing down at its
  own words every couple of seconds
- **turns red and bloodshot** (veins in the sclera) on errors
- **falls asleep** after 4 minutes of no mouse movement — lids droop and it
  "breathes"; move the mouse to wake it

## Models

<img width="1920" height="1040" alt="AEYE_6OsCrCEzoc" src="https://github.com/user-attachments/assets/1f48d3bb-a06f-4731-b5af-ef755f9a6606" />


The dropdown always defaults to the **last model you used** (any backend); on a
fresh install it starts on the house default. In the library, every **model name
is a link** — click it to open the model's HuggingFace or Ollama page in your
default browser for an overview and benchmarks.

- **Ollama** — anything Ollama serves shows up in the model dropdown. Pull new
  models from the drawer (`▸ model management`) with live progress.
- **HuggingFace** — enter a repo id (e.g. `Qwen/Qwen2.5-1.5B-Instruct`) in the
  drawer and hit *load*. Weights download on first load and run in-process via
  transformers with `device_map="auto"`. Tick *4-bit* to quantize with
  bitsandbytes (needs a CUDA GPU). Tick *trust remote code* for repos that ship
  their own custom model code (only enable it for repos you trust).

### Do I need to log in? (No, for public models)

**No login is required for public models** — that's the vast majority, including
nearly all the uncensored/abliterated ones. AEYE ships loginless and works out
of the box. A token is only needed for **gated** repos — mainly Meta *Llama* and
Google *Gemma* — which require accepting a license on the model's page. Those are
flagged *gated* in the library, and a failed load explains exactly what's wrong
instead of a raw error.

To unlock gated repos (optional), create a free token at
<https://huggingface.co/settings/tokens> (type *Read*) and accept the license on
the model's page. Then give AEYE the token — **no interactive login**. Easiest
first:

1. **Token file (simplest).** Put the token as the only line in
   **`%APPDATA%\AEYE\hf_token.txt`** — Settings shows the exact folder with an
   *open keys folder* button. AEYE loads it automatically on launch; keep the file
   private.
2. **Environment variable.** Set `HF_TOKEN` for your account, then relaunch AEYE:
   `setx HF_TOKEN hf_xxxxxxxxxxxxxxxx`.

AEYE reads `HF_TOKEN` / `HUGGING_FACE_HUB_TOKEN` / `HUGGINGFACE_TOKEN` if any is
present. If none is set, everything public still works — no login required.

> Bleeding-edge models sometimes fail to *hf load* with "architecture not
> recognized" — that's a transformers-version gap, **not** a login issue. If a
> **GGUF** build of the same model exists, pull it via Ollama instead (search the
> library); that path handles brand-new architectures.

## Hardware scan & model library

On startup the server scans your hardware (CPU name via the registry, RAM via
`GlobalMemoryStatusEx`, GPU + VRAM via `nvidia-smi`) — the result shows as a
badge in the header. The **library** button opens the full model catalog:
~60 models from 0.5B to 671B, each with q4 download size and RAM/VRAM
requirements, tagged **FITS GPU** / **CPU ONLY** / **TOO BIG** for *your*
machine. Filter by fit or search, then **pull** (Ollama, with live progress in
the row) or **hf load** (transformers) straight from the table. Incompatible
models stay listed — you can see exactly what they'd need.

The model dropdown also gets a *"suggested for your hardware"* group: popular
models that fit but aren't installed — selecting one starts the pull.

### Search the whole hub

The curated catalog is only a starting point. The **search bar** at the top of
the library queries **all of HuggingFace and the Ollama library live** — any
repo, any size, catalog or not. Type a name (min 3 chars; it debounces as you
type) and results come back grouped by source:

- **Ollama library** results pull by name (`ollama pull <name>`).
- **HuggingFace** results are classified automatically:
  - **GGUF** repos → a quant dropdown + **pull**, which pulls the GGUF straight
    into Ollama via `hf.co/<repo>:<tag>`. Only tags Ollama actually accepts are
    offered — `latest` (the maintainer's default) plus any canonical quant the
    repo ships (`Q4_K_M`, `Q6_K`, `Q8_0`, …). Non-standard names a repo might
    use (e.g. a bare `Q4_K`) are hidden because Ollama rejects them; `latest`
    covers them.
  - **transformers** repos → **hf load** (respects the drawer's 4-bit checkbox).
  - **image** repos (diffusers / text-to-image) → **load ▸ imagine**.

Each result shows downloads, likes, a *gated* flag, and a ↗ link to its page.
So a specific model like `huihui-ai/Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-GGUF`
is one search-and-pull away — and, because it's abliterated, it's also pinned
into the curated **uncensored** list as *Qwythos Mythos 9B Abliterated*.

### Auto-updating trending models

On every launch AEYE does a **silent background scan** — if you're online it
queries HuggingFace's trending list (general, *plus* a dedicated pass for
freshly-trending **uncensored / abliterated** models) and the Ollama library,
and folds the latest & greatest into the catalog automatically. The eye turns
violet while the scan runs; a status line at the top of
the library reads e.g. *"103 trending models · updated 12s ago"*, with a
**refresh trending** button to rescan on demand.

- Trending rows are marked with a 🔥 and can be isolated with the **🔥 trending**
  filter. Uncensored models are still ranked first; within each bucket the
  newest/most-trending come first.
- Results are **cached to `catalog_cache.json`**, so the library is populated
  instantly on the next start and still works fully **offline** (the status line
  shows *"offline — showing cached trending models"*). The scan silently no-ops
  if there's no connection.
- Sizes come from the model name when it carries a parameter count; otherwise
  the scan asks the repo itself — exact parameter totals from safetensors
  metadata, real quant sizes from GGUF file listings, and weight-file totals
  for image pipelines. Only rows with nothing to go on (e.g. Ollama family
  pages spanning many sizes) stay **SIZE ?** — click the model name to check
  its page. GGUF repos become one-click Ollama pulls, transformers repos
  become **hf load**, and trending image models load into the diffusers
  pipeline.

## Search the whole hub (any model, catalog or not)

<img width="1920" height="1040" alt="AEYE_rZmMtSG3YA" src="https://github.com/user-attachments/assets/82a78452-77bb-4bed-9b8c-9d1c3e9adfb0" />

The library has a **search hub** bar at the top that queries **all of
HuggingFace and the entire Ollama library** live — not just the curated catalog,
and regardless of whether a model fits your machine. Type a name (e.g.
`Qwythos`, `dolphin`, `sdxl`) and results stream back in two groups:

- **Ollama library** — official models, one-click **pull**.
- **HuggingFace Hub** — every matching repo, tagged by how it runs:
  - **GGUF** → pulled straight into Ollama. A quant dropdown offers `latest`
    (the maintainer's default) plus every quant tag Ollama actually accepts;
    non-standard quant names that Ollama would reject are hidden so a pull never
    dead-ends.
  - **transformers** → **hf load** in-process (honours the 4-bit checkbox).
  - **image gen** → **load ▸ imagine** into the diffusers pipeline.

Each result shows download/like counts, a *gated* flag for license-gated repos,
and a ↗ link to its page. Results are ranked by relevance; searching is
debounced as you type (or hit Enter / **search hub**).

The abliterated **Qwythos Mythos 9B** (Qwen3.5, 1M context, vision + tool-use)
ships in the curated catalog as a one-click pull, and — like anything else — is
also findable through the search hub.

## Removing models & voices (de-bloat)

Downloaded models pile up fast. To clear space:

- **Library → 💾 installed** — a live view of *everything* on disk (Ollama models
  and cached HuggingFace repos), biggest first, with the total GB. Hit the 🗑 on
  any row to delete it; the freed space is reported. Non-catalog models you
  pulled (search-hub GGUFs, `hf.co/…` pulls) show up here too.
- **Inline 🗑** — any catalog row whose model is already downloaded gets a
  trashcan next to its pull/load button, so you can remove it right where you got
  it.
- **Voices** — in the drawer's **Voice** section, a downloaded Piper voice shows a
  🗑 next to it; deleting removes just that voice's files (voices share one repo,
  so the others stay).

Deletes ask for confirmation. Deleting a model that's currently loaded unloads it
first. Ollama deletions go through Ollama; HuggingFace deletions clear the repo
from the HF cache.

## Vision (image input)

Drag & drop an image anywhere over the chat panel, paste from the clipboard, or
use the 📎 button. Thumbnails appear above the composer; on send the images ride
along in the message so a **vision model can read them**. Use an Ollama vision
model — `llava`, `llama3.2-vision`, or `gemma3` (all in the library). Attaching
an image to a text-only model returns a clean "model does not support images"
notice rather than failing silently.

## Image generation (imagine)

<img width="1920" height="1040" alt="image" src="https://github.com/user-attachments/assets/f5be23bb-0ea0-448a-a75f-e99d306662f9" />


The library has an **image gen** category — SD 1.5/2.1, SDXL + Turbo, Playground
v2.5, SD 3.5, and FLUX.1 — each with VRAM requirements and a fit verdict.
Hit **load ▸ imagine** on a row to load it into the diffusers pipeline (the
`img:` badge tracks it). Then the **imagine** button opens a panel: prompt,
negative prompt, steps, guidance, size and seed. Generate, then **download** the
PNG or **send to chat** to drop it into the transcript. The NSFW safety checker
is disabled, and fp16 + model-CPU-offload keep SDXL/FLUX alive on 8 GB cards.

> Image generation and HF model loading pin **transformers < 5** — the 5.x CLIP
> loader is incompatible with the current diffusers release. The installer's AI-extras step
> handles this automatically.

## Video generation (dream)

The library also has a **text-to-video** category. Hit **load ▸ dream** on a video
model to load it, then the **dream** button opens a panel much like imagine —
prompt, steps, guidance, frame count, fps and seed. AEYE writes an **MP4** when a
codec backend is available, and otherwise falls back to an **animated GIF** (via
Pillow alone) — so video works even without the optional dependency. AnimateDiff
motion adapters are supported on an SD 1.5 base, and the same fp16 +
model-CPU-offload tricks keep it alive on smaller cards. Download the clip or
**send to chat** to drop it into the transcript.

## Voice (100% local, both ways)

<img width="1920" height="1040" alt="image" src="https://github.com/user-attachments/assets/5ffe9c59-1d1f-4880-bd21-f13af660b3c9" />


Speech in **and** out is **100% on-device**. Text-to-speech is
[Piper](https://github.com/rhasspy/piper); speech-to-text is
[Whisper](https://github.com/SYSTRAN/faster-whisper). Nothing — no audio, no
reply text — ever leaves the machine.

> **No cloud voices.** The browser's own mic API (which streamed audio to
> Microsoft/Google) and the browser/"Natural" TTS voices (which sent reply text
> to Microsoft) were **removed** for a no-log, no-network path. The mic below is
> different: it records locally and transcribes with an on-device Whisper model.

- **🔊 speaker** — **on by default**: the eye reads replies aloud as they
  finish. Click to mute; the toggle, chosen voice and effect persist across
  sessions (also in the desktop app).
- **🎤 mic** — click to dictate: it records from your microphone, transcribes
  locally with Whisper (`faster-whisper`), and drops the text into the chat box
  for you to edit or send. The model (~140 MB for `base`) downloads once on
  first use, then works fully offline. Install it by ticking the AI extras during setup (or later from Start-menu ▸ Install or Repair AI Extras); without it the mic button
  stays disabled. Set `AEYE_WHISPER_MODEL` (tiny/base/small/medium/large-v3) to
  trade speed for accuracy — default `base`, CPU int8 so it never touches the
  LLM's VRAM.

### Choosing a voice

Open the drawer (`▸ model management`) → **Voice (local Piper TTS)**. Pick from
**21 voices** (US / UK, plus characterful **Scottish** and **Northern English**
accents, male & female) and hit **download** (~60–115 MB, fetched once from
`rhasspy/piper-voices`); a ● means it's ready, ○ means not yet. The `rate` slider
maps to Piper's length-scale. Hit **test** to preview, **🗑** to delete a voice.

**Effects.** The **effect** dropdown applies a preset to *any* voice:
- **Pitch presets** (cheap, dependency-free): `goblin`, `demon`, `giant`, `troll`
  (deep) and `chipmunk`, `sprite`, `gremlin` (high).
- **Horror chains** (real DSP via Spotify's [pedalboard](https://github.com/spotify/pedalboard)):
  `dalek` (ring-mod corrupted machine), `corrupted` (ring-mod + bitcrush +
  distortion), `radiodemon` (digital broadcast: bandlimited + bit-crushed + ring-
  mod demon with **random data-beeps and dropouts**), `possessed` (detuned many-
  voices), `intercom` (bandlimited facility PA), `wraith` (deep + heavy reverb),
  `hive` (voice swarm). Each stacks pitch-shift, ring modulation, detuned
  layering, bitcrush, distortion and dark reverb. If `pedalboard` isn't installed
  they simply don't appear.
- **`random`** shuffles the horror effects mid-speech (every 3–8 words), keeping
  your selected voice fixed — a corrupting-in-place, shifting-signal horror.

**Streaming speech.** Replies are spoken **sentence-by-sentence as they generate**,
played back gaplessly through the Web Audio API — the eye starts talking on the
first finished sentence and paces itself to the typewriter (tune with `rate`).

Install Piper by ticking the AI extras during setup (or later from Start-menu ▸ Install or Repair AI Extras). Without it the
🔊 button is disabled (chat still works; it just won't speak).

## Privacy / no-log

By default AEYE keeps **no chat history and no image-generation history** —
anywhere. The **memory** feature below is strictly opt-in and strictly local.

- **Conversations & generated images** are never written to disk unless you
  turn memory on. Chat messages stream through and are held only in the page (a
  refresh or **clear** wipes them). Generated images come back as in-memory data
  and are only saved if *you* hit **download**.
- **No prompt logging.** The server prints only a startup banner and runs the web
  server at `warning` level — no access logs, no request bodies.
- **Voice is fully local** (see above): TTS is Piper on-device and STT is Whisper
  on-device; the browser's cloud mic/voice APIs were removed. Nothing spoken or
  heard leaves the machine.
- **HuggingFace telemetry is disabled** (`HF_HUB_DISABLE_TELEMETRY`), so model
  downloads don't send usage pings.
- The only files AEYE writes are non-conversational settings: `.aeye_state.json`
  (the last chat + image models, for auto-reload), `catalog_cache.json` (the
  public trending-model list), `aeye.log` (desktop-mode server log) and the
  `.webview` profile (selected model and voice preferences — the desktop
  equivalent of browser `localStorage`). Delete any of them anytime — they'll
  be recreated.
- **Exception — memory, if you turn it on:** saved conversations live as plain
  JSON under `./memory` on this machine, written only while the toggle is on
  and readable/deletable by you at any time. Nothing in it is ever uploaded.

## Memory (opt-in chat history & projects)

<img width="1920" height="1040" alt="image" src="https://github.com/user-attachments/assets/3b863ed8-1212-45b3-a6b4-a7c7ffa8555d" />


The **memory** button in the top bar opens the eye's long-term memory. It ships
**off**; flip *remember my chats* to enable it. While on:

- Every completed exchange is appended to a local file under `memory/chats/`.
  The current chat keeps growing until you press **clear** (which files it away)
  or close the app.
- On exit the model writes a short **briefing** of the conversation. Resuming a
  long chat later feeds the model that briefing plus the last few messages —
  it picks up where it left off without re-reading the whole transcript.
- Chats can be grouped into **projects** (create them in the modal, assign via
  the per-chat dropdown). The **context** selector picks what the eye recalls
  while you talk:
  - **automatic** — briefings of past chats are injected only when your message
    overlaps their topic;
  - **project: X** — that project's briefings always ride along, and new chats
    are filed into the project automatically.
- **resume** reloads a saved conversation into the chat panel; 🗑 forgets it.

Turning the toggle off stops all writes immediately — existing files stay until
you delete them (in the modal, or just delete the `memory/` folder).

External components keep their own state: **Ollama** writes its own `server.log`
(model loads/requests, not full prompts) under `%LOCALAPPDATA%\Ollama\`, and model
weights live in the HuggingFace/Ollama caches (manage them from **💾 installed**).

## Modelfile editor

The **modelfile** button (next to the temp slider) opens an editor: pick any
installed Ollama model, *load modelfile* to see its recipe (FROM, TEMPLATE,
PARAMETER, SYSTEM...), edit it, give it a new name, and *create from
modelfile* — which runs `ollama create` and streams the build output. The
**create** button runs the build directly once the editor is primed.

Temperature, max tokens and a system prompt are adjustable in the top bar /
drawer. Enter sends; Shift+Enter inserts a newline.

## Plugins

<img width="1920" height="1040" alt="image" src="https://github.com/user-attachments/assets/72bf976a-f6fa-4352-8087-d51242e8dc0f" />


AEYE ships a small **plugin system** for wiring in your own local tools. Drop a
folder into `%APPDATA%\AEYE\plugins\<id>\` with an `aeye-plugin.json` manifest
(name, trigger, command); a chat message that starts with the trigger runs the
tool and streams its output into a chat bubble. Plugins run **only** from what
*you* type — never from model output — and each can keep its own isolated Python
environment. A bundled **`echo`** sample shows the format and the **`rss`** reader
(below) is a working example; you can also install one straight from a GitHub URL
and edit its manifest in the built-in editor.

## Peer-to-peer (P2P)

Open **p2p** in the top bar to talk **directly to another AEYE instance** — no
server, no account, no cloud in the middle. One side **hosts** a session and
shares a short code; the other **connects** to it over a plain TCP socket
(port **8131**, kept separate from the app's own **8130**).

- **Host** — *Start Session* mints a one-time code (`AEYE-XXXX-XXXX`, valid 10
  minutes) and starts a listener. The window shows the code, your local IP and
  the port to hand to your peer.
- **Connect** — enter the host's IP, port and code. The code is validated on the
  host: a good one is accepted and the link goes live; a bad or expired one is
  rejected cleanly.
- **Chat** — once connected, messages go back and forth in real time
  (newline-delimited JSON over the socket); your own messages echo immediately.
- **Network Tools** — a checkbox for **UPnP** auto port-forwarding (stubbed for
  now) and a link to a **port-forwarding guide**, for reaching a peer across the
  internet. On the same LAN, the local IP + port is enough.
- **Debug Mode** — off by default; on, it surfaces verbose connection/error
  logs. Off keeps message **contents out of the logs** entirely.

If a connection is blocked it's almost always a **VPN or firewall** — the window
says so and suggests disabling the VPN or allowing AEYE through the firewall.

Still early: this layer is **not encrypted yet** (TLS is planned, without
changing the protocol), there's **no file transfer**, and **nothing is
persisted** — close the window and the conversation is gone.

## Running on modest hardware

<img width="1920" height="1040" alt="image" src="https://github.com/user-attachments/assets/70d3a7c5-ba35-4b68-9942-cc9860bbb5ec" />


AEYE is built to stay usable on modest or GPU-light machines:

- **Nothing auto-loads at boot.** A model loads only when you pick it, so a fresh
  launch uses almost no RAM/VRAM. A startup picker offers to restore just the last
  models you used — loaded one at a time so they never fight over VRAM.
- **CPU-only picks.** The library tags every model **FITS GPU / CPU ONLY /
  TOO BIG** for *your* hardware, and plenty of small (0.5–3B) models run happily
  on CPU.
- **Hide the GPU-hungry extras.** Under *settings ▸ Display* you can **hide the
  eye** (its 78×30 grid stops rendering entirely — freeing the GPU and giving the
  chat the full width) and **cap its frame rate** (15–60 fps). The scrolling
  price / board tickers can be hidden too.
- **CPU offload for image/video.** fp16 + model-CPU-offload keep SDXL/FLUX and the
  video pipelines alive on 8 GB cards; a pipeline that can't fit simply stays idle
  instead of crashing.

## Configuration

Environment variables (set before launching AEYE):

| Variable      | Default                  | Purpose                    |
|---------------|--------------------------|----------------------------|
| `AEYE_PORT` | `8130`                   | Web UI port                |
| `AEYE_HOST` | `127.0.0.1`              | Bind address               |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Where Ollama is listening  |

## Header tickers

Two rows of scrolling strips along the top of the window (opt-in, gated behind
**web access**):

- **Price tickers** — commodities (left, drifting right→left) and crypto (right,
  left→right), quoted from Yahoo Finance and refreshed each minute. Choose which
  symbols show, or hide the whole strip, in *manage ▸ settings ▸ Price tickers*.
- **Board tickers** — one lane per 4chan board (defaults `/pol/ /g/ /v/ /x/`),
  showing recent thread **titles only**; click a title to open the thread in your
  system browser. Per-lane scroll direction and titles-per-lane are configurable.
  **Off by default.**

4chan's API can't be read directly from the app, so the board strips fetch through
a **feed relay** you pick (*settings ▸ Board tickers ▸ relay mode*):

- **off** (default) — board strips stay dark.
- **local** — the bundled `aeye-4chan-relay.py` runs a tiny CORS relay on
  `127.0.0.1:8788`, entirely on your machine. The installer can register it to
  start hidden at login (opt-in), or run it yourself:
  `pythonw %APPDATA%\AEYE\relay\aeye-4chan-relay.py`.
- **custom** — any RSS-Bridge or CORS-proxy URL template (`{board}` / `{url}`
  placeholders); the ticker parses either 4chan JSON or RSS/Atom.

### RSS reader plugin

The bundled `rss` plugin prints RSS/Atom feeds in chat. Links from **paywalled**
domains are auto-wrapped through `archive.is` for 1-click archiving; manage the
allowlist with `rss paywall list | add <domain> | remove <domain> | reset`
(persisted in `paywalls.json` beside the plugin).

### Display settings

The default theme is **OLED** (true black). Under *settings ▸ Display*,
**auto-scroll chat to newest** can be turned off so long output (like an RSS feed)
stays readable from the top. Your API keys live in `%APPDATA%\AEYE`
(`hf_token.txt` for HuggingFace, `web_keys.txt` for web/RSS keys).

## Layout

```
aeye/
├── server.py            FastAPI server (Ollama proxy + HF / diffusers backends)
├── desktop.py           desktop entrypoint (server + UI in a native window)
├── aeye-4chan-relay.py  local CORS relay for the board tickers (opt-in)
├── build.py             builds the frozen app (PyInstaller) -> dist/AEYE
├── aeye.spec            PyInstaller spec
├── installer/           Inno Setup script -> aeye-setup-vX.Y.Z.exe (the installer)
├── assets/              installer assets (WebView2 bootstrapper, skull frames, icon)
├── tools/               extras / Ollama / relay setup scripts run by the installer
├── plugins/             bundled sample plugins (echo, rss)
├── requirements*.txt    core + optional (hf / img / tts / stt) deps
├── install.bat          dev only: set up a local .venv and run from source
├── start.bat            dev only: run server + browser from source
└── static/              the 100%-hackable UI — index.html, style.css and the
                     eye / chat / library / imagine / dream / voice / stt /
                     ticker / boards / plugins / theme JS modules
```
