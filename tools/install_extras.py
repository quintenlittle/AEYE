"""AEYE AI-extras installer -- builds the optional sidecar venv.

The frozen AEYE.exe can only *import* extra packages; it can't pip-install them.
So the heavy, GPU-dependent AI stack (torch/transformers/diffusers/whisper/RAG)
lives in a SEPARATE venv under %APPDATA%\\AEYE\\extras, built by THIS script with
a real CPython whose major.minor MATCHES the interpreter the app was frozen with
(that version is recorded at build time in `pybuild.txt`). At runtime paths.py
prepends that venv's site-packages to sys.path so `import torch` just works --
which only loads cleanly when the ABI matches.

Run by the installer (with flags) and re-runnable anytime from the Start-Menu
"Install / Repair AI Extras" shortcut (interactive if no flags given).

    python install_extras.py --reqs <app-dir> [--all|--hf --image --video --stt --rag]
                             [--gpu auto|cuda|cpu] [--venv <dir>]

It refuses to run under a Python whose major.minor differs from pybuild.txt,
because wheels built for a different minor version won't import into the app.
"""
import argparse
import os
import subprocess
import sys

CUDA_INDEX = "https://download.pytorch.org/whl/cu124"

FEATURES = {
    # flag        requirements file          human label
    "hf":    ("requirements-hf.txt",    "HuggingFace transformers models"),
    "image": ("requirements-img.txt",   "image generation (diffusers)"),
    "video": ("requirements-video.txt", "video generation (mp4 encoder)"),
    "stt":   ("requirements-stt.txt",   "speech-to-text (Whisper)"),
    "rag":   ("requirements-rag.txt",   "document memory (RAG)"),
}


def _appdata_extras() -> str:
    base = os.environ.get("APPDATA") or os.path.expanduser("~")
    return os.path.join(base, "AEYE", "extras")


def _required_pyver(reqs: str) -> str:
    """The major.minor the app was frozen with, recorded by build.py. Empty if
    unknown (running against a source checkout, say) -> no enforcement."""
    try:
        with open(os.path.join(reqs, "pybuild.txt"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def _check_python(required: str) -> None:
    cur = f"{sys.version_info.major}.{sys.version_info.minor}"
    if required and cur != required:
        sys.exit(
            f"[X] AI extras must use Python {required} (found {cur}).\n"
            f"    The app was frozen with {required}; wheels for another minor\n"
            f"    version won't import. Install Python {required} and re-run with it."
        )


def _venv_python(venv: str) -> str:
    return os.path.join(venv, "Scripts", "python.exe")


def _run(cmd: list, label: str) -> None:
    print(f"\n[*] {label}\n    {' '.join(cmd)}", flush=True)
    r = subprocess.run(cmd)
    if r.returncode != 0:
        sys.exit(f"[X] {label} failed (exit {r.returncode}).")


def _pip(vpy: str, *args: str) -> list:
    return [vpy, "-m", "pip", *args]


def _has_nvidia() -> bool:
    try:
        subprocess.run(["nvidia-smi"], stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=True)
        return True
    except (OSError, subprocess.CalledProcessError):
        return False


def _select_interactive() -> set:
    print("\nChoose AI extras to install (blank = all):")
    keys = list(FEATURES)
    for i, k in enumerate(keys, 1):
        print(f"  {i}. {FEATURES[k][1]}")
    raw = input("\nNumbers (e.g. 1 3 5), or Enter for all: ").strip()
    if not raw:
        return set(keys)
    chosen = set()
    for tok in raw.replace(",", " ").split():
        if tok.isdigit() and 1 <= int(tok) <= len(keys):
            chosen.add(keys[int(tok) - 1])
    return chosen or set(keys)


def main() -> None:
    ap = argparse.ArgumentParser(description="Install AEYE AI extras (sidecar venv).")
    ap.add_argument("--reqs", default=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    help="dir holding the requirements-*.txt files (the app dir)")
    ap.add_argument("--venv", default=_appdata_extras(), help="target venv dir")
    ap.add_argument("--gpu", choices=("auto", "cuda", "cpu"), default="auto")
    ap.add_argument("--all", action="store_true", help="install every feature")
    for k in FEATURES:
        ap.add_argument(f"--{k}", action="store_true", help=FEATURES[k][1])
    args = ap.parse_args()

    reqs = os.path.abspath(args.reqs)
    _check_python(_required_pyver(reqs))

    # which features?
    if args.all:
        want = set(FEATURES)
    else:
        want = {k for k in FEATURES if getattr(args, k)}
    if not want:
        want = _select_interactive()

    missing = [FEATURES[k][0] for k in want
               if not os.path.exists(os.path.join(reqs, FEATURES[k][0]))]
    if missing:
        sys.exit(f"[X] requirements file(s) not found in {reqs}: {', '.join(missing)}")

    venv = os.path.abspath(args.venv)
    print("=" * 60)
    print("AEYE AI extras")
    print(f"  target venv : {venv}")
    print(f"  features    : {', '.join(sorted(want))}")
    print("=" * 60)

    # 1. venv (matches the frozen 3.12 ABI so its wheels import in-process)
    vpy = _venv_python(venv)
    if not os.path.exists(vpy):
        os.makedirs(os.path.dirname(venv), exist_ok=True)
        _run([sys.executable, "-m", "venv", venv], "Creating extras virtual environment")
    else:
        print("[OK] Extras venv already exists -- updating in place.")

    _run(_pip(vpy, "install", "--upgrade", "pip", "wheel"), "Upgrading pip / wheel")

    # 2. torch first, matched to the GPU (its build determines CPU vs CUDA)
    needs_torch = bool(want & {"hf", "image", "video", "stt", "rag"})
    if needs_torch:
        use_cuda = args.gpu == "cuda" or (args.gpu == "auto" and _has_nvidia())
        if use_cuda:
            _run(_pip(vpy, "install", "torch", "--index-url", CUDA_INDEX),
                 "Installing PyTorch (CUDA build)")
        else:
            _run(_pip(vpy, "install", "torch"), "Installing PyTorch (CPU build)")

    # 3. each selected feature's requirements
    for k in ("hf", "image", "video", "stt", "rag"):
        if k in want:
            req = os.path.join(reqs, FEATURES[k][0])
            _run(_pip(vpy, "install", "-r", req), f"Installing {FEATURES[k][1]}")

    # 4. bitsandbytes (optional 4-bit) -- best-effort, never fatal
    if "hf" in want:
        print("\n[*] Installing bitsandbytes (optional 4-bit loading) ...", flush=True)
        subprocess.run(_pip(vpy, "install", "bitsandbytes"))

    # success marker the installer checks to confirm extras actually landed
    # (any earlier `_run` failure calls sys.exit and never reaches here)
    try:
        with open(os.path.join(venv, ".aeye_extras_ok"), "w", encoding="utf-8") as f:
            f.write(",".join(sorted(want)) + "\n")
    except OSError:
        pass

    print("\n" + "=" * 60)
    print("[OK] AI extras ready. Restart AEYE to load them.")
    print("=" * 60)


if __name__ == "__main__":
    main()
