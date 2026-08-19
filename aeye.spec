# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for AEYE -- the frozen CORE app (onedir, windowed).

Bundles only the always-on runtime: FastAPI/uvicorn/httpx/psutil/pywebview and
Piper TTS. The heavy AI stack (torch/transformers/diffusers/whisper/RAG) is
deliberately EXCLUDED -- it ships as an optional version-matched sidecar venv
under %APPDATA%\\AEYE\\extras that paths.py injects at runtime. Keeping it out
here is what keeps the installer small.

Build via `python build.py` (which also generates assets/version_info.txt), or
directly with `pyinstaller aeye.spec`.
"""
import os
import sys
from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = os.path.abspath(os.getcwd())


def _res(*p):
    return os.path.join(ROOT, *p)


# --- data files (read-only, land in the bundle root == paths.RESOURCE_DIR) ---
datas = [
    (_res("static"), "static"),
    (_res("skull.txt"), "."),
    (_res("version.txt"), "."),
    (_res("AEYE.ico"), "."),
    (_res("plugins", "echo"), os.path.join("plugins", "echo")),
    (_res("plugins", "rss"), os.path.join("plugins", "rss")),
]
binaries = []
hiddenimports = []

# uvicorn loads its loops/protocols by string name -> not seen by the analyzer
hiddenimports += collect_submodules("uvicorn")
hiddenimports += [
    "websockets", "websockets.legacy", "httptools",
    "h11", "anyio", "click",
    "webview.platforms.winforms", "clr",
    # local P2P package (imported by server.py) -- belt-and-braces so the
    # analyzer never drops the submodules
    "p2p", "p2p.session", "p2p.connection", "p2p.upnp", "p2p.tls", "p2p.filetransfer",
]

# pull in package data + native libs for the runtime deps that ship them
# (piper voices download via huggingface_hub; pedalboard powers the voice FX)
for pkg in ("webview", "piper", "piper_phonemize", "onnxruntime",
            "huggingface_hub", "pedalboard"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception as e:  # optional / not installed in this build venv
        print(f"[aeye.spec] collect_all({pkg!r}) skipped: {e}")

# CRITICAL for the AI-extras sidecar: PyInstaller only bundles the stdlib
# modules the CORE app imports, so the extras (torch needs `pickletools`, pypdf
# needs `xml.dom`, ...) hit "No module named ..." at runtime. Bundle the FULL
# standard library so any extras dependency finds its stdlib needs. Skip the
# GUI / dev / deprecated corners we never want in a server exe.
_STDLIB_SKIP = {
    "antigravity", "this", "idlelib", "lib2to3", "turtle", "turtledemo",
    "tkinter", "test", "ensurepip", "venv", "distutils", "pydoc_data",
    "__hello__", "__phello__",
}
for _name in sorted(getattr(sys, "stdlib_module_names", ())):
    if _name.startswith("_") or _name in _STDLIB_SKIP:
        continue
    hiddenimports.append(_name)
    try:
        hiddenimports += collect_submodules(_name)   # xml -> xml.dom.* etc.
    except Exception:
        pass

# keep the heavy AI stack OUT of the core exe -- it lives in the sidecar venv
excludes = [
    "torch", "torchvision", "torchaudio",
    "transformers", "diffusers", "accelerate", "safetensors",
    "faiss", "sentence_transformers", "faster_whisper", "ctranslate2",
    "scipy", "sympy", "pandas", "matplotlib", "tkinter",
    "bitsandbytes", "av", "imageio_ffmpeg", "trafilatura", "pypdf",
]

_verinfo = _res("assets", "version_info.txt")
version_file = _verinfo if os.path.exists(_verinfo) else None
_icon = _res("AEYE.ico")

block_cipher = None

a = Analysis(
    ["desktop.py"],
    pathex=[ROOT],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="AEYE",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,            # windowed -- no console flash
    disable_windowed_traceback=False,
    icon=_icon,
    version=version_file,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="AEYE",
)
