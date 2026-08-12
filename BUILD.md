# Building the AEYE Windows installer

This turns the source app into a professional installer:
`dist\aeye-setup-vX.Y.Z.exe` — a GUI setup (black/green, with an animated
"speaking skull") that installs AEYE to **Program Files**, adds Start-Menu +
Desktop shortcuts, a real uninstaller, and detects/installs WebView2.

The build is **one command**. Everything below is context.

---

## TL;DR

```bat
build.bat
```

Or, with a specific Python and a version bump:

```bat
set AEYE_BUILD_PY=py -3.12
build.bat --bump patch
```

Output: `dist\aeye-setup-v<version>.exe`.

---

## Prerequisites

| Tool | Why | Notes |
|---|---|---|
| **Python 3.11–3.13** | freezes the app | `build.bat` makes its own `.buildvenv`. Whatever minor version you build with becomes the required version for the AI-extras venv (recorded in `pybuild.txt`). |
| **Inno Setup 6.1+** | builds the installer | Needs 6.1+ for `CreateCallback` (the skull animation). Get it from jrsoftware.org. `build.py` auto-finds `ISCC.exe`; skip with `--no-installer`. |
| Internet (first build) | fetches the WebView2 bootstrapper + default Piper voice | Both are cached under `assets\`; later builds are offline. |

> **ABI rule (important):** the frozen app and the optional AI-extras venv must
> share the same Python **major.minor**. `build.py` records the build version in
> `pybuild.txt`; the extras installer reads it and refuses to use a mismatched
> Python. Build and support with a consistent Python version.

---

## What the build does (`build.py`)

1. **Clean** `build\` and `dist\`.
2. **Version** — reads `version.txt` (source of truth). `--bump patch|minor|major`
   or `--set X.Y.Z` rewrites it. Injected into the exe's version resource, the
   installer metadata, and the output filename.
3. **Generate build inputs** into `assets\`:
   - `pybuild.txt` — the build Python's `major.minor`.
   - `version_info.txt` — Windows VERSIONINFO for the exe.
   - `skull_frames\jaw0..2.txt` — the installer's animated skull (a Python port
     of `static\skull.js`'s mandible drop).
   - `MicrosoftEdgeWebview2Setup.exe` — downloaded if absent.
   - `hf-cache\` — best-effort pre-fetch of the default Piper voice (`--no-voice`
     to skip). Not relied upon: the app auto-downloads the voice on first run
     regardless (see First run below).
4. **PyInstaller** (`aeye.spec`) — a **onedir**, windowed (no console) build →
   `dist\AEYE\` (`AEYE.exe` + `_internal\`).
5. **Inno Setup** (`installer\aeye.iss`) → `dist\aeye-setup-vX.Y.Z.exe`.

---

## Architecture: core exe + Ollama + optional sidecar

A frozen exe can't `pip install` per-GPU wheels into itself, so the app is split:

- **Frozen core (always present):** FastAPI/uvicorn/httpx/psutil/pywebview +
  **Piper TTS**. Ollama-backed chat, web access, memory, docs UI, plugins,
  themes, game — all work offline immediately.
- **"Local models" = Ollama.** The installer's *Ollama* component installs the
  Ollama runtime and pulls the default chat model. AEYE proxies it over HTTP; no
  Python ML deps needed for the primary experience.
- **AI Extras (optional, installable later):** the heavy stack
  (torch/transformers/diffusers/Whisper/RAG) installs into a **sidecar venv** at
  `%APPDATA%\AEYE\extras`, built by `tools\install_extras.py` with a Python that
  matches `pybuild.txt`. At boot `paths.py` prepends that venv's `site-packages`
  to `sys.path`, so `import torch` resolves in-process — **no server.py changes**.
  Per-GPU torch (CUDA vs CPU) is preserved because a real Python does the install.

Run/repair extras anytime from the Start-Menu **"Install or Repair AI Extras"**
shortcut, or:

```bat
"%ProgramFiles%\AEYE\tools\install-extras.bat" --hf --rag --gpu auto
```

---

## Paths: bundle vs. writable data (`paths.py`)

| | Frozen install | From source (dev) |
|---|---|---|
| **RESOURCE_DIR** (read-only: `static\`, `skull.txt`, `version.txt`, sample plugin) | the unpacked bundle (`_internal\`) | the repo |
| **DATA_DIR** (writable: `memory\`, docs, `catalog_cache.json`, `.aeye_state.json`, `aeye.log`, `hf_token.txt`, `web_keys.txt`, `plugins\`, `extras\`, `hf-cache\`) | `%APPDATA%\AEYE` | the repo (unchanged dev workflow) |

So Program Files stays read-only, per-user data lives in AppData, and running
from source behaves exactly as before. `paths.py` also seeds the AppData tree,
loads `hf_token.txt` into the environment, seeds the sample plugin, and injects
the extras venv.

---

## Large models & first run

**Nothing large is bundled** (keeps the installer small):

- **Ollama models** live in Ollama's own store; pulled by the Ollama component
  or from the AEYE library UI later.
- **HuggingFace / diffusers weights** download on demand into `%APPDATA%\AEYE\hf-cache`
  once the AI extras are installed.
- **Piper voices** download on demand from the TTS drawer. The **default voice
  (`en_US-danny-low`) auto-downloads on first launch** (background, online,
  best-effort) via `server._ensure_default_voice` — so TTS works out of the box
  without bundling anything. Override with `AEYE_DEFAULT_VOICE`.

**First launch** creates the AppData tree, seeds the `echo` sample plugin,
fetches the default voice, and shows the usual startup model picker (nothing
auto-loads — RAM-safe).

**AI extras auto-install:** when the *AI extras* component is selected, the
installer runs `tools\install-extras.bat` automatically as part of setup (own
console, as the real user, waited-on) — so document-memory/RAG, Whisper, and the
rest are in before AEYE first opens. This is a multi-GB download and needs
Python matching `pybuild.txt` (winget-installed on the target if missing).
Deselect the component (Compact/Custom) to skip it and add extras later from the
Start-Menu shortcut instead.

---

## Versioning

`version.txt` (e.g. `1.0.0`) is the single source of truth.

```bat
build.bat --bump patch     :: 1.0.0 -> 1.0.1
build.bat --bump minor     :: -> 1.1.0
build.bat --bump major     :: -> 2.0.0
build.bat --set 1.4.2      :: explicit
```

The version flows into `AEYE.exe` properties, the installer's Add/Remove entry,
the `aeye-setup-vX.Y.Z.exe` filename, and `/api/version` in the app.

---

## Upgrades & uninstall

- **Upgrade in place:** a stable `AppId` means re-running a newer setup installs
  over the old one in the same folder. User data in `%APPDATA%\AEYE` is untouched.
- **Uninstall:** removes the Program Files app and shortcuts, and *asks* whether
  to also delete `%APPDATA%\AEYE` (chats, memory, docs, models, extras venv).
  Default keeps it for a future reinstall.

---

## Project layout

```
version.txt          version source of truth
pybuild.txt          (generated) build Python major.minor
paths.py             frozen-aware paths + boot (imported first by server/desktop)
aeye.spec            PyInstaller spec (core, onedir, windowed)
build.py / build.bat one-command build
installer\aeye.iss   Inno Setup script (components, WebView2, upgrade, skull)
tools\                install_extras.py + .bat, setup_ollama.bat
assets\               icon, version_info, skull frames, WebView2, voice cache, wizard BMPs
build\                PyInstaller scratch (disposable)
dist\                 AEYE\ (frozen) + aeye-setup-vX.Y.Z.exe
```

---

## Troubleshooting

- **`ISCC.exe not found`** — install Inno Setup 6.1+, or `build.py --no-installer`
  to just freeze.
- **App won't start after install** — WebView2 missing; the installer auto-installs
  it, but if the offline bootstrapper wasn't bundled, install "Evergreen WebView2
  Runtime" from Microsoft. Check `%APPDATA%\AEYE\aeye.log`.
- **`import torch`/`transformers` fails after installing extras** — first check
  the ABI rule (the extras venv's Python must match `pybuild.txt`). Two frozen-app
  hazards are already handled in code, and are the first place to look if it
  regresses:
  - *Shadowing:* PyInstaller's importer serves bundle copies of shared deps
    (huggingface_hub, numpy, ...) ahead of the extras venv, and those aren't the
    coherent set the extras were built against. `paths._ExtrasFinder` fixes this
    by resolving any extras-provided package before the frozen importer.
  - *Missing stdlib:* PyInstaller only bundles the stdlib the CORE app imports,
    so extras hit `No module named pickletools` / `xml.dom`. `aeye.spec` bundles
    the **full stdlib** (`sys.stdlib_module_names`) to prevent this.
  - **Debug it:** launch with `AEYE_DIAG=1` and read `%APPDATA%\AEYE\aeye.log` —
    `server._diag_extras` logs an OK/FAIL line + traceback for every extras
    package, showing exactly which import and which missing dependency fails.
- **pywebview / pythonnet not bundled** — `aeye.spec` uses `collect_all("webview")`;
  if a WebView2 backend file is missing at runtime, add it to the spec's `datas`.
- **Optional wizard art** — drop `assets\wizard-large.bmp` (164×314) and
  `assets\wizard-small.bmp` (55×58) to brand the wizard; they're used only if
  present. Full wizard reskinning beyond banners + the skull page isn't supported
  by Inno's engine without third-party plugins.
