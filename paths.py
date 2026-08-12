"""AEYE path + bootstrap resolution -- the one place that knows where things live.

Imported FIRST by both entrypoints (server.py, desktop.py), before anything
heavy (numpy/torch/onnxruntime) is touched, because it also injects the optional
AI-extras site-packages onto sys.path.

Two roots:

  RESOURCE_DIR  read-only bundled assets (static/, skull.txt, version.txt, the
                sample plugin, the icon). Under a PyInstaller build this is the
                unpacked bundle (sys._MEIPASS); running from source it's the repo.

  DATA_DIR      writable per-user data (memory/, docs, catalog cache, tiny state,
                logs, tokens, user plugins, the AI-extras venv). Under a frozen
                build this is %APPDATA%/AEYE so Program Files stays read-only;
                running from source it stays the repo, so the dev workflow and
                every existing file location are unchanged.

Everything here is import-safe and dependency-free (stdlib only): a failure in
any optional step (extras injection, plugin seeding) degrades quietly -- the
core app must still boot.
"""
import importlib.abc
import importlib.machinery
import os
import sys

FROZEN = bool(getattr(sys, "frozen", False))

# --- resource root (read-only bundle) --------------------------------------
if FROZEN:
    RESOURCE_DIR = getattr(sys, "_MEIPASS", os.path.dirname(sys.executable))
else:
    RESOURCE_DIR = os.path.dirname(os.path.abspath(__file__))


# --- data root (writable per-user) -----------------------------------------
def _default_data_dir() -> str:
    # explicit override always wins (tests, portable installs)
    override = os.environ.get("AEYE_DATA")
    if override:
        return os.path.abspath(override)
    if FROZEN:
        base = os.environ.get("APPDATA") or os.path.expanduser("~")
        return os.path.join(base, "AEYE")
    # running from source: keep everything in the repo, exactly as before
    return RESOURCE_DIR


DATA_DIR = _default_data_dir()

# canonical writable locations (server.py imports these)
MEMORY_DIR = os.path.join(DATA_DIR, "memory")
PLUGINS_DIR = os.path.join(DATA_DIR, "plugins")
EXTRAS_DIR = os.path.join(DATA_DIR, "extras")          # the AI-extras venv
STATE_FILE = os.path.join(DATA_DIR, ".aeye_state.json")
CATALOG_CACHE = os.path.join(DATA_DIR, "catalog_cache.json")
WEB_KEYS_FILE = os.path.join(DATA_DIR, "web_keys.txt")
HF_TOKEN_FILE = os.path.join(DATA_DIR, "hf_token.txt")
LOG_FILE = os.path.join(DATA_DIR, "aeye.log")
WEBVIEW_DIR = os.path.join(DATA_DIR, ".webview")


def _ensure_dirs() -> None:
    for d in (DATA_DIR, MEMORY_DIR, PLUGINS_DIR,
              os.path.join(MEMORY_DIR, "docs", "files"),
              os.path.join(MEMORY_DIR, "docs", "chunks"),
              os.path.join(MEMORY_DIR, "docs", "vectors")):
        try:
            os.makedirs(d, exist_ok=True)
        except OSError:
            pass


def resource(*parts: str) -> str:
    """Absolute path to a bundled (read-only) asset."""
    return os.path.join(RESOURCE_DIR, *parts)


# --- version ---------------------------------------------------------------
def _read_version() -> str:
    try:
        with open(resource("version.txt"), encoding="utf-8") as f:
            return f.read().strip() or "0.0.0"
    except OSError:
        return "0.0.0"


__version__ = _read_version()


# --- AI-extras injection ----------------------------------------------------
class _ExtrasFinder(importlib.abc.MetaPathFinder):
    """Resolve any package that lives in the extras venv BEFORE PyInstaller's
    frozen importer.

    A plain `sys.path.insert` is NOT enough in a frozen app: PyInstaller's
    importer sits ahead of the filesystem path finder in `sys.meta_path`, so a
    package baked into the bundle (e.g. huggingface_hub, numpy) is served from
    the bundle and SHADOWS the extras copy -- and the bundle's versions are not
    the coherent set the extras (torch/transformers/...) were installed against,
    which breaks `import transformers`. Placing this finder first makes the
    extras' self-consistent dependency set win for the top-level names the extras
    provide -- EXCEPT the core-owned packages below, which must always resolve
    from the frozen bundle (they were built together, and a future extras install
    that happens to pull one of them -- e.g. gradio dragging in fastapi/pydantic/
    click -- must not shadow the running web/runtime stack)."""

    # Packages the frozen core owns; the extras venv never overrides these.
    # DELIBERATELY only packages the AI stack (torch/transformers/diffusers/
    # sentence_transformers/faster_whisper/faiss/pypdf) never imports -- so
    # forcing the bundled copy can't break the extras -- while still shielding
    # the running web/desktop/TTS stack from a future extras that happens to pull
    # one of them in (e.g. gradio dragging in fastapi/starlette/pydantic).
    # Shared low-level deps the AI stack DOES import (typing_extensions, certifi,
    # idna, httpx, anyio, numpy, huggingface_hub, ...) are intentionally NOT here:
    # those must keep coming from the coherent extras set.
    _CORE_OWNED = frozenset({
        # web server stack (never imported by the AI packages)
        "fastapi", "starlette", "uvicorn", "httptools", "websockets",
        "pydantic", "pydantic_core", "annotated_types",
        # desktop / runtime
        "webview", "clr", "clr_loader", "pythonnet", "psutil",
        # bundled native TTS libs (keep the versions their .pyd/.dll were built with)
        "piper", "piper_phonemize", "pedalboard",
    })

    def __init__(self, site: str):
        self._site = site
        self._names = self._scan(site) - self._CORE_OWNED

    @staticmethod
    def _scan(site: str) -> set:
        names = set()
        try:
            for e in os.listdir(site):
                if e == "__pycache__" or e.endswith((".dist-info", ".egg-info")):
                    continue
                if os.path.isdir(os.path.join(site, e)):
                    names.add(e)                       # package (regular/namespace)
                elif e.endswith((".py", ".pyd", ".so")):
                    names.add(e.split(".")[0])         # single-file module / ext
        except OSError:
            pass
        return names

    def find_spec(self, fullname, path=None, target=None):
        if fullname.split(".")[0] not in self._names:
            return None
        search = [self._site] if path is None else list(path)
        try:
            return importlib.machinery.PathFinder.find_spec(fullname, search, target)
        except Exception:
            return None


def _inject_extras() -> None:
    """Make the optional sidecar venv (torch/transformers/diffusers/whisper/RAG)
    importable by the frozen interpreter. The venv is built with the SAME
    CPython major.minor the app is frozen with, so its wheels are ABI-compatible.
    Absent extras -> the core app runs exactly as before."""
    site = os.path.join(EXTRAS_DIR, "Lib", "site-packages")
    if not os.path.isdir(site):
        return
    # a finder ahead of PyInstaller's importer so extras beat the bundled copies
    sys.meta_path.insert(0, _ExtrasFinder(site))
    # keep it on sys.path too (for .pth files / pkg_resources / plain lookups)
    if site not in sys.path:
        sys.path.insert(0, site)
    # native DLLs (torch\lib, *.libs) must be discoverable by the loader
    if hasattr(os, "add_dll_directory"):
        for rel in ("torch/lib",):
            p = os.path.join(site, *rel.split("/"))
            if os.path.isdir(p):
                try:
                    os.add_dll_directory(p)
                except OSError:
                    pass
        # numpy/scipy/pillow ship *.libs sibling dirs full of DLLs
        try:
            for name in os.listdir(site):
                if name.endswith(".libs"):
                    p = os.path.join(site, name)
                    if os.path.isdir(p):
                        try:
                            os.add_dll_directory(p)
                        except OSError:
                            pass
        except OSError:
            pass


# --- env seeding (frozen only) ---------------------------------------------
def _seed_env() -> None:
    """Load the optional HF token from the data dir and keep model/voice caches
    under AppData in a frozen build. Never override a deliberate user choice."""
    if not os.environ.get("HF_TOKEN"):
        try:
            with open(HF_TOKEN_FILE, encoding="utf-8") as f:
                tok = f.read().strip()
            if tok:
                os.environ["HF_TOKEN"] = tok
        except OSError:
            pass
    # in a frozen install keep the HuggingFace cache (models + Piper voices)
    # inside AppData so it's predictable. But DON'T override it when the user
    # already has a populated ~/.cache/huggingface -- reuse their existing models
    # instead of silently re-downloading gigabytes into AppData.
    if FROZEN and not os.environ.get("HF_HOME"):
        user_hub = os.path.join(os.path.expanduser("~"),
                                ".cache", "huggingface", "hub")
        if not os.path.isdir(user_hub):
            os.environ["HF_HOME"] = os.path.join(DATA_DIR, "hf-cache")


# --- sample plugin seed -----------------------------------------------------
def _seed_sample_plugins() -> None:
    """First run: copy the bundled sample plugins (echo, rss, ...) into the
    user's writable plugins dir so the plugins tab isn't empty. Never clobber a
    plugin the user already has."""
    src_root = resource("plugins")
    if not os.path.isdir(src_root):
        return
    import shutil
    for name in os.listdir(src_root):
        src = os.path.join(src_root, name)
        dst = os.path.join(PLUGINS_DIR, name)
        if os.path.isdir(src) and not os.path.exists(dst):
            try:
                shutil.copytree(src, dst)
            except (OSError, shutil.Error):
                pass


def bootstrap() -> None:
    """Run the whole boot sequence. Idempotent; safe to call more than once."""
    _ensure_dirs()
    _seed_env()
    _inject_extras()
    if FROZEN:
        _seed_sample_plugins()


# run on import -- extras injection must happen before heavy imports elsewhere
bootstrap()


if __name__ == "__main__":
    # `python paths.py` -- quick introspection / smoke test
    print(f"AEYE version : {__version__}")
    print(f"frozen       : {FROZEN}")
    print(f"RESOURCE_DIR : {RESOURCE_DIR}")
    print(f"DATA_DIR     : {DATA_DIR}")
    print(f"extras venv  : {EXTRAS_DIR} "
          f"({'present' if os.path.isdir(os.path.join(EXTRAS_DIR, 'Lib', 'site-packages')) else 'absent'})")
