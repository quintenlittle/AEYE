"""
AEYE -- the all-seeing local LLM container.

A single-file FastAPI server that fronts two model backends:

  * Ollama       -- proxied over its local HTTP API (list / pull / chat)
  * HuggingFace  -- loaded in-process with transformers (optional install)

and serves the ASCII-eye web UI from ./static.
"""

import asyncio
import codecs
import json
import os
import platform
import queue
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from typing import Optional

# resolve resource/data roots and inject the optional AI-extras venv onto
# sys.path -- MUST run before any heavy import (numpy/torch/onnxruntime) so the
# sidecar's copies win. Also seeds the data dir, HF token and sample plugins.
import paths  # noqa: E402
import p2p  # noqa: E402  -- P2P subsystem (session codes + TCP handshake + UPnP stub)

# no-log posture: silence HuggingFace's download telemetry pings before any
# hub/transformers/diffusers import reads this. Weights still download; only
# the anonymous usage ping is suppressed.
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


def _offline_guard() -> None:
    """When there's no internet, flip HuggingFace into offline mode BEFORE any
    hub/transformers/diffusers import so cached models load instantly.

    Without this, every model load does a HEAD request to huggingface.co that,
    offline, burns a full retry backoff (~23 s per file) before falling back to
    the local cache -- the app looks dead for minutes on an offline boot. A hard
    flag would break in-app downloads when online, so we probe first and only go
    offline when the probe fails. An explicit HF_HUB_OFFLINE set by the user
    always wins (we never override a deliberate choice).
    """
    if os.environ.get("HF_HUB_OFFLINE") is not None:
        return
    import socket
    try:
        # a real TCP connect to the host we actually use -- DNS + reachability
        # in one short check; ~1.5 s ceiling so an offline boot isn't stalled.
        socket.create_connection(("huggingface.co", 443), timeout=1.5).close()
    except OSError:
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TRANSFORMERS_OFFLINE"] = "1"


_offline_guard()

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

OLLAMA = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
HOST = os.environ.get("AEYE_HOST", "127.0.0.1")
PORT = int(os.environ.get("AEYE_PORT", "8130"))
# local speech-to-text model (faster-whisper). tiny/base/small/medium/large-v3;
# base is a good speed/accuracy balance and stays off the LLM's VRAM (CPU int8).
WHISPER_MODEL = os.environ.get("AEYE_WHISPER_MODEL", "base")
# read-only bundle root (repo when running from source, the unpacked PyInstaller
# bundle when frozen) -- static/, index.html, skull.txt live here
ROOT = paths.RESOURCE_DIR
__version__ = paths.__version__


def _extras_hint() -> str:
    """How to install the optional AI extras, worded for the current build:
    the frozen installer build uses the Start-Menu shortcut; a source checkout
    uses install.bat."""
    return ("run 'Install or Repair AI Extras' from the Start Menu"
            if paths.FROZEN else "re-run install.bat")

app = FastAPI(title="AEYE")
app.mount("/static", StaticFiles(directory=os.path.join(ROOT, "static")), name="static")


@app.middleware("http")
async def _no_stale_ui(request, call_next):
    """The desktop webview's HTTP cache happily serves week-old JS after an
    update. Force revalidation on the UI files -- against a local server a
    304 costs nothing, and changes always reach the window."""
    resp = await call_next(request)
    p = request.url.path
    if p == "/" or p.startswith("/static"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# The server is unauthenticated by design (single-user, loopback). Two cheap
# checks stop a random web page the user is browsing from driving this API:
#  * Host allowlist -- defeats DNS rebinding. A rebinding attack reaches us
#    over the attacker's hostname, which won't be in the set; the real UI
#    always sends 127.0.0.1/localhost:<port>.
#  * Origin allowlist on writes -- a cross-site POST carries the attacker's
#    Origin (CORS blocks reading our reply, but the side effect would still
#    fire without this). Same-origin fetches send our own Origin or none.
_ALLOWED_HOSTS = {f"{h}:{PORT}" for h in ("127.0.0.1", "localhost", "[::1]", HOST)}
_ALLOWED_ORIGINS = {f"http://{h}" for h in _ALLOWED_HOSTS}


@app.middleware("http")
async def _guard_origin(request, call_next):
    host = (request.headers.get("host") or "").lower()
    if host not in _ALLOWED_HOSTS:
        return Response("forbidden: unexpected Host", status_code=421)
    # only writes are dangerous; a present-but-foreign Origin means cross-site
    if request.method not in ("GET", "HEAD", "OPTIONS"):
        origin = request.headers.get("origin")
        if origin is not None and origin.lower() not in _ALLOWED_ORIGINS:
            return Response("forbidden: cross-origin write", status_code=403)
    return await call_next(request)


def _sse(obj) -> str:
    """Encode one server-sent-event frame."""
    return f"data: {json.dumps(obj)}\n\n"


# --------------------------------------------------------------------------
# Tiny persisted state (survives restarts) -- e.g. last image model, so it
# can auto-reload on the next launch.
# --------------------------------------------------------------------------

STATE_FILE = paths.STATE_FILE
_STATE_LOCK = threading.Lock()


def _load_state() -> dict:
    try:
        with open(STATE_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_state(**changes) -> None:
    """Merge changes into the on-disk state file (best-effort)."""
    with _STATE_LOCK:
        state = _load_state()
        state.update(changes)
        try:
            tmp = STATE_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(state, f)
            os.replace(tmp, STATE_FILE)
        except Exception:
            pass


# --------------------------------------------------------------------------
# Hardware scan (dependency-free: winreg + ctypes + nvidia-smi)
# --------------------------------------------------------------------------

NOWIN = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
NEWCONSOLE = 0x00000010 if os.name == "nt" else 0  # CREATE_NEW_CONSOLE

_HW: Optional[dict] = None
_HW_LOCK = threading.Lock()


def scan_hardware() -> dict:
    """Detect CPU, RAM and GPUs. Cached after the first run."""
    global _HW
    with _HW_LOCK:
        if _HW is not None:
            return _HW
        hw = {"cpu": None, "cores": os.cpu_count(), "ram_gb": None,
              "gpus": [], "vram_gb": 0.0, "cuda": False,
              "os": platform.platform()}

        # CPU marketing name from the registry (falls back to platform)
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                r"HARDWARE\DESCRIPTION\System\CentralProcessor\0") as key:
                hw["cpu"] = winreg.QueryValueEx(key, "ProcessorNameString")[0].strip()
        except Exception:
            hw["cpu"] = platform.processor() or platform.machine()

        # physical RAM via GlobalMemoryStatusEx
        try:
            import ctypes

            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [("dwLength", ctypes.c_ulong),
                            ("dwMemoryLoad", ctypes.c_ulong)] + [
                    (n, ctypes.c_ulonglong) for n in (
                        "ullTotalPhys", "ullAvailPhys", "ullTotalPageFile",
                        "ullAvailPageFile", "ullTotalVirtual",
                        "ullAvailVirtual", "ullAvailExtendedVirtual")]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            hw["ram_gb"] = round(stat.ullTotalPhys / 2**30, 1)
        except Exception:
            pass

        # NVIDIA GPUs (the ones that matter for local inference)
        try:
            out = subprocess.check_output(
                ["nvidia-smi", "--query-gpu=name,memory.total",
                 "--format=csv,noheader,nounits"],
                text=True, timeout=8, creationflags=NOWIN)
            for line in out.strip().splitlines():
                name, _, mem = line.rpartition(",")
                hw["gpus"].append({"name": name.strip(),
                                   "vram_gb": round(float(mem) / 1024, 1)})
        except Exception:
            pass

        if hw["gpus"]:
            hw["cuda"] = True
            hw["vram_gb"] = max(g["vram_gb"] for g in hw["gpus"])
        else:
            # non-NVIDIA / integrated: report names, no usable VRAM figure
            try:
                out = subprocess.check_output(
                    ["powershell", "-NoProfile", "-Command",
                     "(Get-CimInstance Win32_VideoController).Name"],
                    text=True, timeout=15, creationflags=NOWIN)
                hw["gpus"] = [{"name": n.strip(), "vram_gb": 0.0}
                              for n in out.splitlines() if n.strip()]
            except Exception:
                pass

        _HW = hw
        return hw


# --------------------------------------------------------------------------
# Live system telemetry (CPU / RAM / GPU / network) for the header meters.
# Uses psutil when present; falls back to ctypes for CPU + RAM. GPU via
# nvidia-smi (short-cached so rapid polls don't spawn it repeatedly).
# --------------------------------------------------------------------------

_STATS_LOCK = threading.Lock()
_NET_PREV = {"t": None, "sent": 0, "recv": 0}
_GPU_CACHE = {"t": 0.0, "data": None}
_CPU_PREV = {"idle": None, "total": None}


def _cpu_ram_ctypes():
    """Dependency-free CPU% (GetSystemTimes deltas) + RAM% (GlobalMemoryStatusEx)."""
    out = {}
    try:
        import ctypes

        class FT(ctypes.Structure):
            _fields_ = [("lo", ctypes.c_uint32), ("hi", ctypes.c_uint32)]

        def val(ft):
            return (ft.hi << 32) | ft.lo

        idle, kern, user = FT(), FT(), FT()
        if ctypes.windll.kernel32.GetSystemTimes(
                ctypes.byref(idle), ctypes.byref(kern), ctypes.byref(user)):
            i, total = val(idle), val(kern) + val(user)
            pi, pt = _CPU_PREV["idle"], _CPU_PREV["total"]
            _CPU_PREV["idle"], _CPU_PREV["total"] = i, total
            if pi is not None and total > pt:
                busy = 1.0 - (i - pi) / (total - pt)
                out["cpu_pct"] = round(max(0.0, min(1.0, busy)) * 100, 1)
    except Exception:
        pass
    try:
        import ctypes

        class MSX(ctypes.Structure):
            _fields_ = [("l", ctypes.c_ulong), ("load", ctypes.c_ulong)] + [
                (n, ctypes.c_ulonglong) for n in
                ("tp", "ap", "tpf", "apf", "tv", "av", "aev")]

        m = MSX()
        m.l = ctypes.sizeof(MSX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m))
        out["ram_pct"] = float(m.load)
        out["ram_total_gb"] = round(m.tp / 2**30, 1)
        out["ram_used_gb"] = round((m.tp - m.ap) / 2**30, 1)
    except Exception:
        pass
    return out


def _gpu_stats():
    now = time.time()
    with _STATS_LOCK:
        if _GPU_CACHE["data"] is not None and now - _GPU_CACHE["t"] < 0.8:
            return _GPU_CACHE["data"]
    data = None
    try:
        out = subprocess.check_output(
            ["nvidia-smi",
             "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu",
             "--format=csv,noheader,nounits"],
            text=True, timeout=4, creationflags=NOWIN)
        util, used, total, temp = [p.strip() for p in
                                   out.strip().splitlines()[0].split(",")]
        used, total = float(used), float(total)
        data = {"gpu_pct": float(util),
                "vram_used_gb": round(used / 1024, 2),
                "vram_total_gb": round(total / 1024, 2),
                "vram_pct": round(used / total * 100, 1) if total else 0.0,
                "gpu_temp": float(temp)}
    except Exception:
        data = None
    with _STATS_LOCK:
        _GPU_CACHE["t"], _GPU_CACHE["data"] = now, data
    return data


_CPU_TEMP = {"val": None}
# last time a client asked for /api/stats -- lets the temperature poll back off
# hard when nobody is watching the meters (idle CPU/power on low-end machines)
_LAST_STATS_REQ = {"t": 0.0}


def _cpu_temp_loop() -> None:
    """Best-effort CPU temperature (WMI). The perf-counter thermal zone is the
    LIVE value; the MSAcpi class is often cached/stuck (77.1 C forever on this
    very machine) so it is only the fallback. Boards exposing neither just get
    no readout. Slow poll in its own thread: PowerShell is heavy per-spawn."""
    ps = ("$z = Get-CimInstance -Namespace root/cimv2 -ClassName "
          "Win32_PerfFormattedData_Counters_ThermalZoneInformation "
          "-ErrorAction SilentlyContinue; "
          "if ($z) { ($z | ForEach-Object { if ($_.HighPrecisionTemperature) "
          "{ $_.HighPrecisionTemperature / 10 } else { $_.Temperature } } "
          "| Measure-Object -Maximum).Maximum } "
          "else { (Get-CimInstance -Namespace root/wmi -ClassName "
          "MSAcpi_ThermalZoneTemperature -ErrorAction Stop "
          "| Select-Object -First 1).CurrentTemperature / 10 }")
    while True:
        # idle backoff: CPU temp only feeds the gauge hover tooltips, so if no
        # client has fetched /api/stats recently, don't spawn PowerShell at all
        if time.time() - _LAST_STATS_REQ["t"] > 60:
            _CPU_TEMP["val"] = None
            time.sleep(30)
            continue
        hwi = _HWINFO["data"]
        if hwi and hwi.get("cpu_temp") is not None:
            time.sleep(30)      # HWiNFO covers it; skip the PowerShell spawn
            continue
        try:
            out = subprocess.check_output(
                ["powershell", "-NoProfile", "-Command", ps],
                text=True, timeout=10, creationflags=NOWIN)
            k = float(out.strip().splitlines()[-1].replace(",", "."))
            c = k - 273.15
            _CPU_TEMP["val"] = round(c, 1) if -20 < c < 120 else None
        except Exception:
            _CPU_TEMP["val"] = None
        time.sleep(30)          # tooltip-only value -> a slow poll is plenty


# --------------------------------------------------------------------------
# HWiNFO sensor bridge (optional, dependency-free). When HWiNFO64 runs with
# "Shared Memory Support" on, its whole sensor table sits in a read-only
# shared-memory block -- real die/junction sensors instead of WMI thermal
# zones, plus readings nvidia-smi can't give (VRAM junction temp, AMD/Intel
# GPU load, per-adapter net rates). Falls back to the HWiNFO "Gadget"
# registry mirror (HKCU\Software\HWiNFO64\VSB) when shared memory is off
# (the free build disables it after 12 h). No HWiNFO -> the WMI/nvidia-smi
# paths below still apply; everything here is best-effort.
# --------------------------------------------------------------------------

_HWINFO = {"t": 0.0, "data": None}
_HWI_TEMP, _HWI_USAGE = 1, 7          # SENSOR_READING_TYPE temp / usage


def _hwi_dec(b: bytes) -> str:
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("mbcs", "ignore")


def _hwinfo_shared_mem():
    """Parse HWiNFO's SM2 block into (sensor, label, unit, type, value) rows."""
    import ctypes
    k32 = ctypes.windll.kernel32
    k32.OpenFileMappingW.restype = ctypes.c_void_p
    k32.OpenFileMappingW.argtypes = [ctypes.c_uint32, ctypes.c_int,
                                     ctypes.c_wchar_p]
    k32.MapViewOfFile.restype = ctypes.c_void_p
    k32.MapViewOfFile.argtypes = [ctypes.c_void_p, ctypes.c_uint32,
                                  ctypes.c_uint32, ctypes.c_uint32,
                                  ctypes.c_size_t]
    k32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
    k32.CloseHandle.argtypes = [ctypes.c_void_p]
    FILE_MAP_READ = 0x0004
    h = None
    for name in ("Global\\HWiNFO_SENS_SM2", "HWiNFO_SENS_SM2"):
        h = k32.OpenFileMappingW(FILE_MAP_READ, False, name)
        if h:
            break
    if not h:
        return None
    view = None
    try:
        view = k32.MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0)
        if not view:
            return None
        hdr = ctypes.string_at(view, 44)
        if hdr[:4] != b"HWiS":            # "DEAD" while HWiNFO shuts down
            return None
        (_sig, _ver, _rev, _poll, s_off, s_size, s_num,
         r_off, r_size, r_num) = struct.unpack("<IIIqIIIIII", hdr)
        buf = ctypes.string_at(view, r_off + r_size * r_num)
        sensors = []
        for i in range(s_num):
            off = s_off + i * s_size
            orig = buf[off + 8:off + 136].split(b"\0")[0]
            user = buf[off + 136:off + 264].split(b"\0")[0]
            sensors.append(_hwi_dec(user or orig).lower())
        rows = []
        for i in range(r_num):
            off = r_off + i * r_size
            rtype, sidx = struct.unpack_from("<II", buf, off)
            label = (buf[off + 140:off + 268].split(b"\0")[0]      # user label
                     or buf[off + 12:off + 140].split(b"\0")[0])   # else orig
            unit = buf[off + 268:off + 284].split(b"\0")[0]
            value, = struct.unpack_from("<d", buf, off + 284)
            rows.append((sensors[sidx] if sidx < len(sensors) else "",
                         _hwi_dec(label).lower(), _hwi_dec(unit), rtype, value))
        return rows or None
    finally:
        if view:
            k32.UnmapViewOfFile(view)
        k32.CloseHandle(h)


def _hwinfo_registry():
    """The HWiNFO 'Report value in Gadget' mirror -- per-sensor opt-in, but it
    keeps working after the free build's 12 h shared-memory window closes."""
    import winreg
    try:
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\HWiNFO64\VSB")
    except OSError:
        return None
    try:
        vals, i = {}, 0
        while True:
            try:
                name, val, _ = winreg.EnumValue(key, i)
            except OSError:
                break
            vals[name] = str(val)
            i += 1
    finally:
        winreg.CloseKey(key)
    rows, n = [], 0
    while f"Label{n}" in vals or f"Sensor{n}" in vals:
        try:
            value = float(vals.get(f"ValueRaw{n}", "").replace(",", "."))
        except ValueError:
            n += 1
            continue
        shown = vals.get(f"Value{n}", "")
        parts = shown.split()
        unit = parts[-1] if len(parts) > 1 else ""
        rtype = (_HWI_TEMP if "°" in shown
                 else _HWI_USAGE if "%" in shown else 0)
        rows.append((vals.get(f"Sensor{n}", "").lower(),
                     vals.get(f"Label{n}", "").lower(), unit, rtype, value))
        n += 1
    return rows or None


def _hwinfo_pick(rows) -> dict:
    """Map raw HWiNFO rows onto /api/stats fields via label heuristics."""
    def best(rtype, sensor_sub, prios, avoid=()):
        top = None
        for sensor, label, _unit, rt, val in rows:
            if rt != rtype or sensor_sub not in sensor:
                continue
            if any(a in label for a in avoid):
                continue
            for rank, p in enumerate(prios):
                if p in label and (top is None or rank < top[0]):
                    top = (rank, val)
                    break
        return top[1] if top else None

    out = {}
    v = best(_HWI_TEMP, "cpu", ("cpu (tctl/tdie)", "cpu package", "cpu die",
                                "cpu ccd", "core temperatures", "cpu"))
    if v is not None and -20 < v < 130:
        out["cpu_temp"] = round(v, 1)
    v = best(_HWI_USAGE, "cpu", ("total cpu usage", "total cpu utility"))
    if v is not None:
        out["cpu_pct"] = round(max(0.0, min(100.0, v)), 1)
    v = best(_HWI_TEMP, "gpu", ("gpu temperature", "gpu thermal diode"),
             avoid=("hot spot", "memory", "junction"))
    if v is not None and -20 < v < 130:
        out["gpu_temp"] = round(v, 1)
    v = best(_HWI_TEMP, "gpu", ("gpu memory junction", "gpu memory temperature"))
    if v is not None and -20 < v < 130:
        out["vram_temp"] = round(v, 1)
    v = best(_HWI_USAGE, "gpu", ("gpu core load", "gpu utilization",
                                 "gpu d3d usage"))
    if v is not None:
        out["gpu_pct"] = round(max(0.0, min(100.0, v)), 1)
    v = best(_HWI_USAGE, "gpu", ("gpu memory usage",))
    if v is not None:
        out["vram_pct"] = round(max(0.0, min(100.0, v)), 1)
    # net rates summed across adapter sensors (units vary with the rate)
    mults = {"b/s": 1 / 1024, "kb/s": 1.0, "mb/s": 1024.0, "gb/s": 1048576.0}
    down = up = None
    for sensor, label, unit, _rt, val in rows:
        mult = mults.get(unit.lower())
        if not sensor.startswith("network") or mult is None:
            continue
        if "dl rate" in label or "download" in label:
            down = (down or 0.0) + val * mult
        elif "up rate" in label or "upload" in label:
            up = (up or 0.0) + val * mult
    if down is not None:
        out["net_down_kbps"] = round(down, 1)
    if up is not None:
        out["net_up_kbps"] = round(up, 1)
    return out


def _hwinfo_loop() -> None:
    """Poll HWiNFO every couple of seconds while it's running; back off when
    it isn't, so launching HWiNFO later gets picked up without a restart."""
    while True:
        data = None
        try:
            rows = _hwinfo_shared_mem() or _hwinfo_registry()
            if rows:
                data = _hwinfo_pick(rows) or None
        except Exception:
            data = None
        _HWINFO["t"], _HWINFO["data"] = time.time(), data
        time.sleep(2.0 if data else 10.0)


def _sys_stats() -> dict:
    out = {}
    try:
        import psutil
        out["cpu_pct"] = psutil.cpu_percent(interval=None)
        vm = psutil.virtual_memory()
        out["ram_pct"] = vm.percent
        out["ram_used_gb"] = round(vm.used / 2**30, 1)
        out["ram_total_gb"] = round(vm.total / 2**30, 1)
        n = psutil.net_io_counters()
        now = time.time()
        with _STATS_LOCK:
            prev = dict(_NET_PREV)
            _NET_PREV.update(t=now, sent=n.bytes_sent, recv=n.bytes_recv)
        if prev["t"]:
            dt = max(now - prev["t"], 1e-3)
            out["net_up_kbps"] = max(0.0, round((n.bytes_sent - prev["sent"]) / dt / 1024, 1))
            out["net_down_kbps"] = max(0.0, round((n.bytes_recv - prev["recv"]) / dt / 1024, 1))
        else:
            out["net_up_kbps"] = out["net_down_kbps"] = 0.0
    except Exception:
        out.update(_cpu_ram_ctypes())
    out["cpu_temp"] = _CPU_TEMP["val"]
    g = _gpu_stats()
    if g:
        out.update(g)
    hwi = _HWINFO["data"] if time.time() - _HWINFO["t"] < 15 else None
    if hwi:
        # HWiNFO wins for temps (real die/junction sensors vs the often-stuck
        # WMI zone) and fills whatever the WMI/nvidia-smi paths couldn't
        # produce (AMD/Intel GPU load, net without psutil). nvidia-smi keeps
        # usage/VRAM when it answered -- its GB figures feed the tooltip.
        for k, v in hwi.items():
            if k.endswith("_temp") or out.get(k) is None:
                out[k] = v
        out["hwinfo"] = True
    return out


# --------------------------------------------------------------------------
# Model catalog -- q4_K_M sizes; requirements derived from size:
#   VRAM >= weights + ~15% KV-cache/overhead, RAM >= weights + OS headroom.
# --------------------------------------------------------------------------

def _m(name, params, size_gb, ollama=None, hf=None, cat="general",
       pop=False, note=""):
    entry = {
        "name": name, "params": params, "size_gb": size_gb,
        "ollama": ollama, "hf": hf, "cat": cat, "pop": pop, "note": note,
        "trending": False, "repo": None,
    }
    if size_gb:                       # requirements derived from the q4 size
        entry["vram_gb"] = round(size_gb * 1.15 + 1.0, 1)
        entry["ram_gb"] = round(size_gb + 3.0, 1)
    else:                             # size unknown (dynamic entry, unparsable)
        entry["vram_gb"] = None
        entry["ram_gb"] = None
    return entry


CATALOG = [
    # ------ uncensored / abliterated (surfaced first in the UI) ------
    _m("Dolphin 3.0 8B", "8B", 4.9, "dolphin3", "cognitivecomputations/Dolphin3.0-Llama3.1-8B", cat="uncensored", pop=True, note="Dolphin: unfiltered compliant assistant (Llama 3.1 base)"),
    _m("Dolphin-Mistral 7B", "7B", 4.1, "dolphin-mistral", "cognitivecomputations/dolphin-2.8-mistral-7b-v02", cat="uncensored", pop=True, note="classic uncensored Mistral fine-tune"),
    _m("Dolphin-Llama3 8B", "8B", 4.7, "dolphin-llama3:8b", "cognitivecomputations/dolphin-2.9-llama3-8b", cat="uncensored", pop=True),
    _m("Dolphin-Llama3 70B", "70B", 40.0, "dolphin-llama3:70b", "cognitivecomputations/dolphin-2.9.1-llama-3-70b", cat="uncensored"),
    _m("Dolphin-Mixtral 8x7B", "47B MoE", 26.0, "dolphin-mixtral:8x7b", "cognitivecomputations/dolphin-2.7-mixtral-8x7b", cat="uncensored", note="MoE: ~13B active"),
    _m("Dolphin-Phi 2.7B", "2.7B", 1.6, "dolphin-phi", "cognitivecomputations/dolphin-2_6-phi-2", cat="uncensored"),
    _m("TinyDolphin 1.1B", "1.1B", 0.6, "tinydolphin", "cognitivecomputations/TinyDolphin-2.8-1.1b", cat="uncensored"),
    _m("GPT-OSS 20B Heretic", "21B MoE", 12.0, None, "p-e-w/gpt-oss-20b-heretic", cat="uncensored", pop=True, note="decensored with Heretic (automated abliteration); MoE ~3.6B active"),
    _m("Qwythos Mythos 9B Abliterated", "9B", 5.8, "hf.co/huihui-ai/Huihui-Qwythos-9B-Claude-Mythos-5-1M-abliterated-GGUF:latest", None, cat="uncensored", pop=True, note="Qwen3.5 abliterated: 1M context, vision + tool-use, reasoning (GGUF, pulled into Ollama)"),
    _m("Llama 3.1 8B Abliterated", "8B", 4.9, "mannix/llama3.1-8b-abliterated", "mlabonne/Meta-Llama-3.1-8B-Instruct-abliterated", cat="uncensored", pop=True, note="refusal direction surgically removed"),
    _m("Llama 3.2 3B Abliterated", "3B", 2.0, "huihui_ai/llama3.2-abliterate:3b", "huihui-ai/Llama-3.2-3B-Instruct-abliterated", cat="uncensored", pop=True),
    _m("Qwen 2.5 7B Abliterated", "7B", 4.7, "huihui_ai/qwen2.5-abliterate:7b", "huihui-ai/Qwen2.5-7B-Instruct-abliterated-v2", cat="uncensored", pop=True),
    _m("Qwen 2.5 14B Abliterated", "14B", 9.0, "huihui_ai/qwen2.5-abliterate:14b", "huihui-ai/Qwen2.5-14B-Instruct-abliterated-v2", cat="uncensored"),
    _m("Qwen 3 8B Abliterated", "8B", 5.2, "huihui_ai/qwen3-abliterated:8b", "huihui-ai/Qwen3-8B-abliterated", cat="uncensored"),
    _m("Gemma 3 12B Abliterated", "12B", 8.1, "huihui_ai/gemma3-abliterated:12b", "huihui-ai/gemma-3-12b-it-abliterated", cat="uncensored"),
    _m("DeepSeek-R1 Distill 14B Abliterated", "14B", 9.0, "huihui_ai/deepseek-r1-abliterated:14b", "huihui-ai/DeepSeek-R1-Distill-Qwen-14B-abliterated-v2", cat="uncensored", note="abliterated reasoning model"),
    _m("DeepSeek-R1 Distill 32B Abliterated", "32B", 20.0, "huihui_ai/deepseek-r1-abliterated:32b", "huihui-ai/DeepSeek-R1-Distill-Qwen-32B-abliterated", cat="uncensored"),
    _m("NeuralDaredevil 8B Abliterated", "8B", 4.9, None, "mlabonne/NeuralDaredevil-8B-abliterated", cat="uncensored", note="abliterated then DPO-healed to recover quality"),
    _m("Llama2 Uncensored 7B", "7B", 3.8, "llama2-uncensored", "georgesung/llama2_7b_chat_uncensored", cat="uncensored"),
    _m("Wizard-Vicuna-Uncensored 13B", "13B", 7.4, "wizard-vicuna-uncensored:13b", "cognitivecomputations/Wizard-Vicuna-13B-Uncensored", cat="uncensored"),
    _m("Wizard-Vicuna-Uncensored 30B", "30B", 18.0, "wizard-vicuna-uncensored:30b", "cognitivecomputations/Wizard-Vicuna-30B-Uncensored", cat="uncensored"),
    # ------ tiny (runs on nearly anything) ------
    _m("Qwen 2.5 0.5B", "0.5B", 0.4, "qwen2.5:0.5b", "Qwen/Qwen2.5-0.5B-Instruct"),
    _m("Qwen 3 0.6B", "0.6B", 0.5, "qwen3:0.6b", "Qwen/Qwen3-0.6B"),
    _m("TinyLlama 1.1B", "1.1B", 0.7, "tinyllama", "TinyLlama/TinyLlama-1.1B-Chat-v1.0"),
    _m("Llama 3.2 1B", "1B", 0.8, "llama3.2:1b", "meta-llama/Llama-3.2-1B-Instruct", pop=True, note="HF repo gated"),
    _m("Gemma 3 1B", "1B", 0.8, "gemma3:1b", "google/gemma-3-1b-it", note="HF repo gated"),
    _m("SmolLM2 1.7B", "1.7B", 1.0, "smollm2:1.7b", "HuggingFaceTB/SmolLM2-1.7B-Instruct"),
    _m("DeepSeek-R1 Distill 1.5B", "1.5B", 1.1, "deepseek-r1:1.5b", "deepseek-ai/DeepSeek-R1-Distill-Qwen-1.5B", cat="reasoning", pop=True),
    _m("Qwen 2.5 1.5B", "1.5B", 1.0, "qwen2.5:1.5b", "Qwen/Qwen2.5-1.5B-Instruct"),
    # ------ small (3-4B) ------
    _m("Llama 3.2 3B", "3B", 2.0, "llama3.2:3b", "meta-llama/Llama-3.2-3B-Instruct", pop=True, note="HF repo gated"),
    _m("Qwen 2.5 3B", "3B", 1.9, "qwen2.5:3b", "Qwen/Qwen2.5-3B-Instruct"),
    _m("Qwen 3 4B", "4B", 2.6, "qwen3:4b", "Qwen/Qwen3-4B"),
    _m("Gemma 3 4B", "4B", 3.3, "gemma3:4b", "google/gemma-3-4b-it", note="vision-capable; HF gated"),
    _m("Phi-3 Mini 3.8B", "3.8B", 2.2, "phi3:mini", "microsoft/Phi-3-mini-4k-instruct"),
    _m("StarCoder2 3B", "3B", 1.7, "starcoder2:3b", "bigcode/starcoder2-3b", cat="code"),
    # ------ mid (7-9B) ------
    _m("Llama 3.1 8B", "8B", 4.9, "llama3.1:8b", "meta-llama/Llama-3.1-8B-Instruct", pop=True, note="HF repo gated"),
    _m("Qwen 2.5 7B", "7B", 4.7, "qwen2.5:7b", "Qwen/Qwen2.5-7B-Instruct", pop=True),
    _m("Qwen 2.5 Coder 7B", "7B", 4.7, "qwen2.5-coder:7b", "Qwen/Qwen2.5-Coder-7B-Instruct", cat="code", pop=True),
    _m("Qwen 3 8B", "8B", 5.2, "qwen3:8b", "Qwen/Qwen3-8B", pop=True),
    _m("Mistral 7B v0.3", "7B", 4.1, "mistral:7b", "mistralai/Mistral-7B-Instruct-v0.3", pop=True),
    _m("Gemma 2 9B", "9B", 5.4, "gemma2:9b", "google/gemma-2-9b-it", note="HF repo gated"),
    _m("DeepSeek-R1 Distill 8B", "8B", 4.9, "deepseek-r1:8b", "deepseek-ai/DeepSeek-R1-Distill-Llama-8B", cat="reasoning"),
    _m("CodeLlama 7B", "7B", 3.8, "codellama:7b", "codellama/CodeLlama-7b-Instruct-hf", cat="code"),
    _m("LLaVA 1.5 7B", "7B", 4.7, "llava:7b", "llava-hf/llava-1.5-7b-hf", cat="vision"),
    _m("Hermes 3 8B", "8B", 4.9, "hermes3:8b", "NousResearch/Hermes-3-Llama-3.1-8B"),
    _m("Granite 3.1 8B", "8B", 4.9, "granite3.1-dense:8b", "ibm-granite/granite-3.1-8b-instruct"),
    # ------ 11-15B ------
    _m("Llama 3.2 Vision 11B", "11B", 7.9, "llama3.2-vision", "meta-llama/Llama-3.2-11B-Vision-Instruct", cat="vision", note="HF repo gated"),
    _m("Mistral Nemo 12B", "12B", 7.1, "mistral-nemo", "mistralai/Mistral-Nemo-Instruct-2407", pop=True, note="Mistral models ship with minimal alignment"),
    _m("Gemma 3 12B", "12B", 8.1, "gemma3:12b", "google/gemma-3-12b-it", note="vision-capable; HF gated"),
    _m("Phi-4 14B", "14B", 9.1, "phi4", "microsoft/phi-4", pop=True),
    _m("Qwen 2.5 14B", "14B", 9.0, "qwen2.5:14b", "Qwen/Qwen2.5-14B-Instruct"),
    _m("Qwen 3 14B", "14B", 9.3, "qwen3:14b", "Qwen/Qwen3-14B"),
    _m("DeepSeek-R1 Distill 14B", "14B", 9.0, "deepseek-r1:14b", "deepseek-ai/DeepSeek-R1-Distill-Qwen-14B", cat="reasoning"),
    _m("StarCoder2 15B", "15B", 9.1, "starcoder2:15b", "bigcode/starcoder2-15b", cat="code"),
    _m("CodeLlama 13B", "13B", 7.4, "codellama:13b", "codellama/CodeLlama-13b-Instruct-hf", cat="code"),
    _m("LLaVA 1.5 13B", "13B", 8.0, "llava:13b", "llava-hf/llava-1.5-13b-hf", cat="vision"),
    # ------ 22-35B ------
    _m("Mistral Small 3.1 24B", "24B", 14.0, "mistral-small3.1", "mistralai/Mistral-Small-3.1-24B-Instruct-2503"),
    _m("Gemma 2 27B", "27B", 16.0, "gemma2:27b", "google/gemma-2-27b-it", note="HF repo gated"),
    _m("Gemma 3 27B", "27B", 17.0, "gemma3:27b", "google/gemma-3-27b-it", pop=True, note="vision-capable; HF gated"),
    _m("Qwen 2.5 32B", "32B", 20.0, "qwen2.5:32b", "Qwen/Qwen2.5-32B-Instruct"),
    _m("Qwen 2.5 Coder 32B", "32B", 20.0, "qwen2.5-coder:32b", "Qwen/Qwen2.5-Coder-32B-Instruct", cat="code"),
    _m("Qwen 3 32B", "32B", 20.0, "qwen3:32b", "Qwen/Qwen3-32B"),
    _m("Qwen 3 30B-A3B", "30B MoE", 19.0, "qwen3:30b", "Qwen/Qwen3-30B-A3B", note="MoE: only ~3B active, fast for its size"),
    _m("QwQ 32B", "32B", 20.0, "qwq", "Qwen/QwQ-32B", cat="reasoning"),
    _m("DeepSeek-R1 Distill 32B", "32B", 20.0, "deepseek-r1:32b", "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B", cat="reasoning"),
    _m("CodeLlama 34B", "34B", 19.0, "codellama:34b", "codellama/CodeLlama-34b-Instruct-hf", cat="code"),
    _m("Command R 35B", "35B", 20.0, "command-r", "CohereForAI/c4ai-command-r-v01"),
    # ------ 70B+ ------
    _m("Llama 3.3 70B", "70B", 43.0, "llama3.3", "meta-llama/Llama-3.3-70B-Instruct", pop=True, note="HF repo gated"),
    _m("Llama 3.1 70B", "70B", 40.0, "llama3.1:70b", "meta-llama/Llama-3.1-70B-Instruct", note="HF repo gated"),
    _m("Qwen 2.5 72B", "72B", 47.0, "qwen2.5:72b", "Qwen/Qwen2.5-72B-Instruct"),
    _m("DeepSeek-R1 Distill 70B", "70B", 43.0, "deepseek-r1:70b", "deepseek-ai/DeepSeek-R1-Distill-Llama-70B", cat="reasoning"),
    _m("CodeLlama 70B", "70B", 39.0, "codellama:70b", "codellama/CodeLlama-70b-Instruct-hf", cat="code"),
    _m("Mixtral 8x7B", "47B MoE", 26.0, "mixtral:8x7b", "mistralai/Mixtral-8x7B-Instruct-v0.1", note="MoE: ~13B active"),
    _m("Mixtral 8x22B", "141B MoE", 80.0, "mixtral:8x22b", "mistralai/Mixtral-8x22B-Instruct-v0.1", note="MoE: ~39B active"),
    _m("Command R+ 104B", "104B", 59.0, "command-r-plus", "CohereForAI/c4ai-command-r-plus"),
    _m("Llama 3.2 Vision 90B", "90B", 55.0, "llama3.2-vision:90b", "meta-llama/Llama-3.2-90B-Vision-Instruct", cat="vision", note="HF repo gated"),
    # ------ monsters (datacenter class) ------
    _m("Qwen 3 235B-A22B", "235B MoE", 142.0, "qwen3:235b", "Qwen/Qwen3-235B-A22B", note="MoE: ~22B active"),
    _m("Llama 3.1 405B", "405B", 229.0, "llama3.1:405b", "meta-llama/Llama-3.1-405B-Instruct", note="HF repo gated"),
    _m("DeepSeek-R1 671B", "671B MoE", 404.0, "deepseek-r1:671b", "deepseek-ai/DeepSeek-R1", cat="reasoning", note="the full R1, MoE: ~37B active"),
    _m("DeepSeek-V3 671B", "671B MoE", 404.0, "deepseek-v3", "deepseek-ai/DeepSeek-V3", note="MoE: ~37B active"),

    # ------ image generation (diffusers -- loaded via the 'gen' backend) ------
    _m("SD 1.5", "0.9B", 2.0, None, "stable-diffusion-v1-5/stable-diffusion-v1-5", cat="image", pop=True, note="fast, light, runs on ~4GB VRAM; 512x512"),
    _m("SD 2.1", "0.9B", 2.6, None, "stabilityai/stable-diffusion-2-1", cat="image", note="768x768 base"),
    _m("SDXL 1.0", "3.5B", 6.9, None, "stabilityai/stable-diffusion-xl-base-1.0", cat="image", pop=True, note="1024x1024, needs ~8GB VRAM"),
    _m("SDXL Turbo", "3.5B", 6.9, None, "stabilityai/sdxl-turbo", cat="image", pop=True, note="1-4 step generation, very fast"),
    _m("SD Turbo", "0.9B", 2.0, None, "stabilityai/sd-turbo", cat="image", note="distilled SD2.1, single-step"),
    _m("Playground v2.5", "3.5B", 6.9, None, "playgroundai/playground-v2.5-1024px-aesthetic", cat="image", note="SDXL-arch, strong aesthetics"),
    _m("SD 3.5 Medium", "2.5B", 5.2, None, "stabilityai/stable-diffusion-3.5-medium", cat="image", note="MMDiT; HF repo gated"),
    _m("SD 3.5 Large", "8B", 16.0, None, "stabilityai/stable-diffusion-3.5-large", cat="image", note="MMDiT; HF gated; ~18GB VRAM"),
    _m("FLUX.1 schnell", "12B", 24.0, None, "black-forest-labs/FLUX.1-schnell", cat="image", pop=True, note="4-step; ~24GB VRAM (offload for less)"),
    _m("FLUX.1 dev", "12B", 24.0, None, "black-forest-labs/FLUX.1-dev", cat="image", note="best quality; HF gated; ~24GB VRAM"),

    # ------ text-to-video (diffusers -- loaded via the 'dream' backend) ------
    _m("AnimateDiff v1.5-3", "1.5B", 2.0, None, "guoyww/animatediff-motion-adapter-v1-5-3", cat="video", pop=True, note="SD1.5 motion adapter; 16-frame clips, 8GB-friendly. Quality depends on the SD1.5 base — set AEYE_ANIMATEDIFF_BASE to a community fine-tune (e.g. emilianJR/epiCRealism) for coherent results"),
    _m("Wan 2.1 T2V 1.3B", "1.3B", 5.0, None, "Wan-AI/Wan2.1-T2V-1.3B-Diffusers", cat="video", pop=True, note="480p ~5s clips; modern T2V built to run on ~8GB"),
    _m("ModelScope T2V 1.7B", "1.7B", 6.5, None, "damo-vilab/text-to-video-ms-1.7b", cat="video", pop=True, note="classic ModelScope T2V; runs on modest VRAM"),
    _m("Zeroscope v2 576w", "1.7B", 5.9, None, "cerspense/zeroscope_v2_576w", cat="video", note="576x320 clips; SD-based T2V"),
    _m("LTX-Video", "2B", 9.0, None, "Lightricks/LTX-Video", cat="video", note="fast DiT video; use offload on 8GB"),
    _m("CogVideoX-2b", "2B", 12.0, None, "THUDM/CogVideoX-2b", cat="video", note="5s 720x480; heavy text encoder, offload on 8GB"),
]


def _fit(entry: dict, hw: dict) -> str:
    """'gpu' fits in VRAM, 'cpu' fits in system RAM (slow), 'no' doesn't fit."""
    if not entry.get("vram_gb"):        # size unknown -> can't judge
        return "unknown"
    if (hw.get("vram_gb") or 0) >= entry["vram_gb"]:
        return "gpu"
    if (hw.get("ram_gb") or 0) >= entry["ram_gb"]:
        return "cpu"
    return "no"


# --------------------------------------------------------------------------
# Live hub search -- query the full HuggingFace Hub + Ollama library, so the
# UI can find ANY model, not just the curated catalog above. HF hosts most
# GGUF quants, which Ollama can pull directly via `ollama pull hf.co/<repo>`.
# --------------------------------------------------------------------------

# quant token inside a GGUF filename, e.g. ...-Q4_K_M.gguf, ...-IQ3_XS.gguf
_QUANT_RE = re.compile(r"\b((?:IQ|Q)\d+(?:_[0-9A-Z]+)*|BF16|FP16|F16|F32)\b", re.I)
# Ollama only accepts a fixed set of canonical quant scheme names as a pull tag
# (`hf.co/repo:TAG`), AND the tag must match a file in the repo. A repo that
# names its files with a non-standard short quant (e.g. `Q4_K` instead of
# `Q4_K_M`) can't be pulled by that tag -- but `:latest` always works, so we
# offer `latest` plus only the quant tags Ollama will actually accept.
OLLAMA_QUANTS = {
    "Q4_0", "Q4_1", "Q5_0", "Q5_1", "Q8_0",
    "Q2_K", "Q3_K_S", "Q3_K_M", "Q3_K_L",
    "Q4_K_S", "Q4_K_M", "Q5_K_S", "Q5_K_M", "Q6_K", "Q8_K",
    "IQ1_S", "IQ1_M", "IQ2_XXS", "IQ2_XS", "IQ2_S", "IQ2_M",
    "IQ3_XXS", "IQ3_XS", "IQ3_S", "IQ3_M", "IQ4_NL", "IQ4_XS",
    "F16", "F32", "BF16",
}
_META_TAG_PREFIXES = ("base_model:", "license:", "region:", "dataset:",
                      "arxiv:", "doi:", "endpoints_compatible")


def _normalize_hf(m: dict) -> dict:
    """Turn a raw HF Hub model record into a compact, UI-ready result."""
    sib = [s.get("rfilename", "") for s in (m.get("siblings") or [])]
    ggufs = [f for f in sib if f.lower().endswith(".gguf")
             and "mmproj" not in f.lower()]
    tags = m.get("tags") or []
    pipeline = m.get("pipeline_tag")
    lib = m.get("library_name")
    mid_low = (m.get("id") or m.get("modelId") or "").lower()
    is_video = (pipeline in ("text-to-video", "image-to-video")
                or "text-to-video" in tags or "image-to-video" in tags
                or any(k in mid_low for k in ("animatediff", "zeroscope",
                       "cogvideo", "hunyuanvideo", "ltx-video", "-t2v", "t2v-")))
    is_image = (pipeline == "text-to-image" or lib == "diffusers"
                or "diffusers" in tags)

    quants = []
    for f in ggufs:
        hit = _QUANT_RE.search(f.rsplit("/", 1)[-1][:-5])  # drop ".gguf"
        if hit:
            q = hit.group(1).upper()
            if q not in quants:
                quants.append(q)

    if ggufs:
        kind = "gguf"
    elif is_video:                     # before image -- T2V repos carry both tags
        kind = "video"
    elif is_image:
        kind = "image"
    else:
        kind = "hf"

    mid = m.get("id") or m.get("modelId")
    # tags Ollama will actually accept: `latest` (always) + valid quant schemes
    # this repo publishes. Non-canonical names (Q4_K, Q5_K) are dropped -- they
    # can't be pulled by tag; `latest` covers the maintainer's default anyway.
    pull_quants = (["latest"] + [q for q in quants if q in OLLAMA_QUANTS]
                   if ggufs else [])
    dq = "latest" if ggufs else None
    ollama_name = f"hf.co/{mid}:latest" if kind == "gguf" else None

    vision = (pipeline == "image-text-to-text"
              or any("mmproj" in f.lower() for f in sib))
    show_tags = [t for t in tags
                 if not t.startswith(_META_TAG_PREFIXES)
                 and t not in ("transformers", "safetensors", "gguf", "pytorch")][:8]

    return {
        "id": mid,
        "kind": kind,
        "quants": quants,
        "pull_quants": pull_quants,
        "default_quant": dq,
        "ollama_name": ollama_name,
        "downloads": m.get("downloads") or 0,
        "likes": m.get("likes") or 0,
        "gated": bool(m.get("gated")),
        "pipeline": pipeline,
        "vision": vision,
        "tags": show_tags,
    }


# --------------------------------------------------------------------------
# Trending refresh -- on startup, if we're online, pull the latest & greatest
# (and freshly-trending uncensored/abliterated) models and fold them into the
# catalog. Results are cached to disk so the library is populated instantly on
# the next launch and still works offline.
# --------------------------------------------------------------------------

CATALOG_CACHE = paths.CATALOG_CACHE

# a parameter count in a model name: 8B, 12b, 3.8B, 70B ...
_PARAM_RE = re.compile(r"(?<![A-Za-z0-9.])(\d{1,3}(?:\.\d+)?)\s*[bB](?![a-zA-Z])")
# mixture-of-experts: 8x7B, 8x22b ...
_MOE_RE = re.compile(r"(\d{1,2})\s*x\s*(\d{1,3}(?:\.\d+)?)\s*[bB]", re.I)
# names that aren't runnable models on their own -- skip them when harvesting
# trending models (embeddings, adapters, and pipeline *components* like the
# text-encoder / VAE / tokenizer that ship as separate repos)
_SKIP_KEYWORDS = ("embed", "rerank", "guard", "moderation",
                  "-bert", "sentence-transformers", "-vae", "vae-", "controlnet",
                  "-lora", "whisper", "-tts", "-stt", "clip-", "-clip",
                  "text-encoder", "text_encoder", "-encoder", "tokenizer",
                  "t5xxl", "-unet", "safetensors-only")


def _estimate_params(name: str):
    """Return (display_str, billions_float) parsed from a model name, or (None, None)."""
    moe = _MOE_RE.search(name)
    if moe:
        n, per = int(moe.group(1)), float(moe.group(2))
        return f"{n}x{per:g}B MoE", n * per
    vals = [float(h) for h in _PARAM_RE.findall(name)]
    vals = [v for v in vals if 0.1 <= v <= 2000]
    if vals:
        pb = max(vals)
        return f"{pb:g}B", pb
    return None, None


def _classify(name: str, tags: list, pipeline: Optional[str]) -> str:
    """Bucket a model into a library category (uncensored wins for priority)."""
    low = name.lower()
    tl = " ".join(tags).lower()
    # video FIRST -- a T2V repo also carries the diffusers/text-to-image-ish
    # tags, so it must win over the image bucket to route to the dream tab
    if (pipeline in ("text-to-video", "image-to-video")
            or "text-to-video" in tl or "image-to-video" in tl
            or any(k in low for k in ("animatediff", "zeroscope", "cogvideo",
                                      "hunyuanvideo", "ltx-video", "text-to-video",
                                      "-t2v", "t2v-", "wan2.1-t2v", "modelscope-t2v"))):
        return "video"
    if pipeline == "text-to-image" or "diffusers" in tags or "text-to-image" in tl:
        return "image"
    if (any(k in low for k in ("abliterat", "uncensored", "dolphin", "heretic",
                               "unfiltered", "unalign", "unhinged"))
            or "uncensored" in tl or "not-for-all-audiences" in tl):
        return "uncensored"
    if (pipeline == "image-text-to-text"
            or any(k in low for k in ("-vl", "-vl-", "vision", "llava"))):
        return "vision"
    if any(k in low for k in ("coder", "starcoder", "-code")):
        return "code"
    if any(k in low for k in ("-r1", "reasoning", "qwq", "-think", "distill")):
        return "reasoning"
    return "general"


def _catalog_keys() -> set:
    """Identity keys for the curated catalog, so we don't add duplicates."""
    keys = set()
    for m in CATALOG:
        if m.get("ollama"):
            keys.add(("o", m["ollama"].split(":")[0].lower()))
        if m.get("hf"):
            keys.add(("h", m["hf"].lower()))
    return keys


def _dyn_key(entry: dict):
    if entry.get("ollama"):
        return ("o", entry["ollama"].split(":")[0].lower())
    if entry.get("hf"):
        return ("h", entry["hf"].lower())
    return ("r", (entry.get("repo") or entry.get("name") or "").lower())


def _dyn_from_hf(m: dict) -> Optional[dict]:
    """Convert a trending HF Hub record into a catalog-shaped entry."""
    mid = m.get("id") or m.get("modelId")
    if not mid:
        return None
    low = mid.lower()
    if any(k in low for k in _SKIP_KEYWORDS):
        return None
    tags = m.get("tags") or []
    pipeline = m.get("pipeline_tag")
    sib = [s.get("rfilename", "") for s in (m.get("siblings") or [])]
    is_gguf = any(f.lower().endswith(".gguf") and "mmproj" not in f.lower()
                  for f in sib)
    name = mid.split("/", 1)[-1]
    cat = _classify(name, tags, pipeline)
    if cat == "image" and pipeline != "text-to-image":
        return None                    # skip VAEs / adapters masquerading as image
    if cat == "video" and (is_gguf
                           or pipeline not in ("text-to-video", "image-to-video")):
        return None                    # only real diffusers T2V pipelines (we
                                       # can't run GGUF video via diffusers/Ollama)
    params, pb = _estimate_params(name)
    size_gb = round(pb * 0.6, 1) if pb else None
    if is_gguf:
        ollama, hf = f"hf.co/{mid}:latest", None
    else:
        ollama, hf = None, mid
    note = "trending on HuggingFace"
    if m.get("gated"):
        note += " · gated repo (accept license on HF first)"
    entry = _m(name, params or "?", size_gb, ollama, hf, cat=cat, pop=True, note=note)
    entry["repo"] = mid
    entry["trending"] = True
    entry["gated"] = bool(m.get("gated"))
    entry["downloads"] = m.get("downloads") or 0
    # full=true gives these too -- kept so the library's sort dropdown can offer
    # the HuggingFace set (likes / recently created / recently updated). ISO
    # strings sort chronologically as-is, so no parsing needed client-side.
    entry["likes"] = m.get("likes") or 0
    entry["created"] = m.get("createdAt") or ""
    entry["updated"] = m.get("lastModified") or ""
    return entry


def _dyn_from_ollama(name: str) -> Optional[dict]:
    """Convert an Ollama library model name into a catalog-shaped entry."""
    low = name.lower()
    if any(k in low for k in _SKIP_KEYWORDS):
        return None
    cat = _classify(name, [], None)
    params, pb = _estimate_params(name)
    size_gb = round(pb * 0.6, 1) if pb else None
    entry = _m(name, params or "?", size_gb, name, None, cat=cat, pop=True,
               note="trending on Ollama")
    entry["repo"] = name
    entry["trending"] = True
    return entry


class RefreshState:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = "idle"          # idle | running | done | offline | error
        self.phase = ""
        self.done = 0
        self.total = 6                # trending, uncensored, image, video, ollama, enrich
        self.updated: Optional[float] = None
        self.progress_at = 0.0       # last time progress advanced (for the watchdog)
        self.error: Optional[str] = None
        self.dynamic: list = []      # merged trending entries


REFRESH = RefreshState()


def _load_catalog_cache() -> None:
    try:
        with open(CATALOG_CACHE, encoding="utf-8") as f:
            data = json.load(f)
        with REFRESH.lock:
            REFRESH.dynamic = data.get("models", [])
            REFRESH.updated = data.get("updated")
    except Exception:
        pass


def _save_catalog_cache() -> None:
    try:
        with REFRESH.lock:
            data = {"updated": REFRESH.updated, "models": REFRESH.dynamic}
        # atomic write (temp + replace) so a hard exit (os._exit on window close)
        # mid-write can't leave catalog_cache.json truncated
        tmp = CATALOG_CACHE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, CATALOG_CACHE)
    except Exception:
        pass


def _refresh_phase(name: str) -> None:
    """Announce the phase we're STARTING (so the label matches current work)."""
    with REFRESH.lock:
        REFRESH.phase = name
        REFRESH.progress_at = time.time()


def _catlog(msg: str) -> None:
    """Verbose catalog/model-discovery logging (dev vs frozen parity debugging).
    Goes to stdout -> aeye.log, so the two environments can be compared."""
    try:
        print("[catalog] " + msg, flush=True)
    except Exception:
        pass


def _refresh_step(collected: list) -> None:
    """Mark a phase complete: advance the bar + persist partial results, so a
    later stall can't lose (or hide) what we already gathered."""
    with REFRESH.lock:
        REFRESH.done += 1
        REFRESH.progress_at = time.time()
        REFRESH.dynamic = list(collected)
        phase = REFRESH.phase
        added = len(collected) - getattr(REFRESH, "_logged_total", 0)
        REFRESH._logged_total = len(collected)
        fetched = getattr(REFRESH, "_fetched", 0)
        skipped = getattr(REFRESH, "_skipped", 0)
        REFRESH._fetched = 0
        REFRESH._skipped = 0
    _catlog("source '{}': +{} new (fetched {}, {} skipped=already-in-catalog) "
            "| dynamic total {}".format(phase, added, fetched, skipped, len(collected)))


# a refresh phase that hasn't advanced in this many seconds is treated as
# stalled -- we finalize with the partial results so the UI never sticks.
_REFRESH_STALL_S = 30


def _refresh_snapshot() -> dict:
    """Status dict, with a watchdog that unsticks a stalled refresh."""
    with REFRESH.lock:
        if (REFRESH.state == "running" and REFRESH.progress_at
                and time.time() - REFRESH.progress_at > _REFRESH_STALL_S):
            REFRESH.state = "done"
            REFRESH.updated = REFRESH.updated or time.time()
            REFRESH.phase = f"added {len(REFRESH.dynamic)} models (a source stalled)"
        return {"state": REFRESH.state, "phase": REFRESH.phase,
                "done": REFRESH.done, "total": REFRESH.total,
                "updated": REFRESH.updated, "count": len(REFRESH.dynamic),
                "error": REFRESH.error}


def _size_entry(e: dict, pb: Optional[float], size_gb: Optional[float] = None) -> None:
    """Fill in params/size/requirements on a dynamic entry (same maths as _m).
    pb may be None (e.g. diffusers pipelines) -- then only the size is known."""
    if pb:
        e["params"] = f"{pb:.1f}".rstrip("0").rstrip(".") + "B"
    e["size_gb"] = max(0.1, round(size_gb if size_gb else pb * 0.6, 1))
    e["vram_gb"] = round(e["size_gb"] * 1.15 + 1.0, 1)
    e["ram_gb"] = round(e["size_gb"] + 3.0, 1)


def _ollama_native(e: dict) -> bool:
    """A model that lives on the Ollama library itself (llama3, gemma...) --
    as opposed to a HuggingFace repo pulled in via an `hf.co/...` tag."""
    return bool(e.get("ollama")) and "/" not in e["ollama"]


def _ollama_size(client, tag: str):
    """(pb, size_gb) for an Ollama library model from its manifest -- the
    model-weights layer size is the real q4 download the user would pull.
    A bare family name resolves to its `:latest` default (what ollama.com
    shows), which is exactly the size we want to display."""
    base, _, ver = tag.partition(":")
    ver = ver or "latest"
    try:
        r = client.get(
            f"https://registry.ollama.ai/v2/library/{base}/manifests/{ver}",
            headers={"Accept": "application/vnd.docker.distribution.manifest.v2+json"},
            timeout=httpx.Timeout(6.0, connect=3.0))
        if r.status_code != 200:
            return None, None
        layers = r.json().get("layers", [])
        size = sum(l.get("size", 0) for l in layers
                   if l.get("mediaType", "").endswith(".model"))
        if size > 2e8:
            gb = size / 2**30
            return gb / 0.6, gb          # q4-ish: ~0.6 GB per B params
    except Exception:
        pass
    return None, None


def _enrich_unknown_sizes(client, collected: list) -> None:
    """The name-parser can't size every model -- ask the source itself instead:
    HF safetensors metadata / GGUF file trees, and for Ollama-library models
    the registry manifest (the :latest tag's real download size). Runs the
    lookups in a small thread pool so a big batch of unknowns stays fast."""
    todo = [e for e in collected if not e.get("size_gb")
            and ((e.get("repo") and "/" in e["repo"]) or _ollama_native(e))]
    if not todo:
        return
    from concurrent.futures import ThreadPoolExecutor

    def _one(e: dict) -> None:
        if _ollama_native(e):                    # Ollama library model
            pb, size = _ollama_size(client, e["ollama"])
            if size:
                _size_entry(e, pb, size)
                if pb and e.get("params"):       # size-derived -> mark approximate
                    e["params"] = "~" + e["params"]
            return
        pb = size = None
        try:  # exact parameter count from safetensors metadata
            r = client.get(f"https://huggingface.co/api/models/{e['repo']}",
                           timeout=httpx.Timeout(5.0, connect=3.0))
            if r.status_code == 200:
                total = (r.json().get("safetensors") or {}).get("total")
                if total and total > 1e7:
                    pb = total / 1e9
        except Exception:
            pass
        if pb is None:
            try:  # real file sizes from the repo tree
                r = client.get(
                    f"https://huggingface.co/api/models/{e['repo']}/tree/main",
                    params={"recursive": "true"},   # quants often sit in subfolders
                    timeout=httpx.Timeout(5.0, connect=3.0))
                if r.status_code == 200:
                    files = r.json()
                    # GGUF repo: group split -00001-of-000NN parts, take the
                    # smallest quant (~ the q4 you'd actually pull)
                    groups: dict = {}
                    wsum = 0
                    for f in files:
                        p = (f.get("path") or "").lower()
                        fs = f.get("size") or 0
                        if p.endswith(".gguf") and "mmproj" not in p:
                            stem = re.sub(r"-\d+-of-\d+(?=\.gguf$)", "", p)
                            groups[stem] = groups.get(stem, 0) + fs
                        elif p.endswith((".safetensors", ".bin", ".pt", ".ckpt")):
                            wsum += fs
                    sizes = [s for s in groups.values() if s > 2e8]
                    if sizes:
                        size = min(sizes) / 2**30
                        pb = size / 0.6          # q4-ish: ~0.6 GB per B params
                    elif wsum > 2e8:
                        # no GGUF: total of the repo's weight files (diffusers
                        # image pipelines etc. -- a real size, no param count)
                        size = wsum / 2**30
            except Exception:
                pass
        if pb or size:
            _size_entry(e, pb, size)

    done_n = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for _ in pool.map(_one, todo):
            done_n += 1
            _refresh_phase(f"sizing unknowns ({done_n}/{len(todo)})")


def _refresh_catalog() -> None:
    """Background: harvest trending models and merge into REFRESH.dynamic."""
    with REFRESH.lock:
        REFRESH.state = "running"
        REFRESH.phase = "connecting"
        REFRESH.done = 0
        REFRESH.progress_at = time.time()
        REFRESH.error = None
    seen = _catalog_keys()
    collected: list = []
    REFRESH._logged_total = 0
    REFRESH._fetched = 0
    REFRESH._skipped = 0
    _catlog("refresh starting -- static CATALOG has {} models ({} uncensored); "
            "dynamic (trending) added on top".format(
                len(CATALOG), sum(1 for m in CATALOG if m.get("cat") == "uncensored")))

    def take(entries):
        for e in entries:
            if not e:
                continue
            REFRESH._fetched = getattr(REFRESH, "_fetched", 0) + 1
            k = _dyn_key(e)
            if k in seen:                    # already in the static catalog / collected
                REFRESH._skipped = getattr(REFRESH, "_skipped", 0) + 1
                continue
            seen.add(k)
            collected.append(e)

    hf_base = "https://huggingface.co/api/models"
    try:
        with httpx.Client(timeout=httpx.Timeout(10.0, connect=5.0),
                          follow_redirects=True,
                          headers={"User-Agent": "AEYE/1.0"}) as client:
            # 1. trending general chat/instruct models
            _refresh_phase("trending models")
            try:
                r = client.get(hf_base, params={
                    "sort": "trendingScore", "direction": -1, "limit": 40,
                    "filter": "text-generation", "full": "true"})
                if r.status_code == 200:
                    take(_dyn_from_hf(m) for m in r.json())
            except httpx.ConnectError:
                with REFRESH.lock:
                    REFRESH.state, REFRESH.phase = "offline", "no internet"
                _catlog("refresh OFFLINE (no internet) -- {} dynamic; the {} static "
                        "models (incl. uncensored) are still served".format(
                            len(collected), len(CATALOG)))
                return
            _refresh_step(collected)

            # 2. freshly-trending uncensored / abliterated (kept a priority)
            _refresh_phase("uncensored models")
            for q in ("abliterated", "uncensored"):
                try:
                    r = client.get(hf_base, params={
                        "search": q, "sort": "trendingScore", "direction": -1,
                        "limit": 20, "full": "true"})
                    if r.status_code == 200:
                        take(_dyn_from_hf(m) for m in r.json())
                except Exception:
                    pass
            _refresh_step(collected)

            # 3. trending image-generation models
            _refresh_phase("image models")
            try:
                r = client.get(hf_base, params={
                    "sort": "trendingScore", "direction": -1, "limit": 20,
                    "filter": "text-to-image", "full": "true"})
                if r.status_code == 200:
                    take(_dyn_from_hf(m) for m in r.json())
            except Exception:
                pass
            _refresh_step(collected)

            # 3b. trending text-to-video models (+ uncensored ones), so the dream
            #     tab has content and uncensored T2V populates like the rest
            _refresh_phase("video models")
            try:
                r = client.get(hf_base, params={
                    "sort": "trendingScore", "direction": -1, "limit": 20,
                    "filter": "text-to-video", "full": "true"})
                if r.status_code == 200:
                    take(_dyn_from_hf(m) for m in r.json())
            except Exception:
                pass
            for q in ("uncensored video", "abliterated video", "nsfw text-to-video"):
                try:
                    r = client.get(hf_base, params={
                        "search": q, "filter": "text-to-video",
                        "sort": "trendingScore", "direction": -1,
                        "limit": 10, "full": "true"})
                    if r.status_code == 200:
                        take(_dyn_from_hf(m) for m in r.json())
                except Exception:
                    pass
            _refresh_step(collected)

            # 4. popular + newest on the Ollama library (capped -- most are
            #    already curated; this catches brand-new additions). This source
            #    is the flakiest, so keep the timeout short: a stall here must
            #    never wedge the refresh.
            _refresh_phase("ollama library")
            added_ol = 0
            for sort in ("popular", "newest"):
                if added_ol >= 15:
                    break
                try:
                    r = client.get("https://ollama.com/library",
                                   params={"sort": sort},
                                   headers={"User-Agent": "Mozilla/5.0"},
                                   timeout=httpx.Timeout(8.0, connect=4.0))
                    if r.status_code != 200:
                        continue
                    names = []
                    for n in re.findall(r'href="/library/([^"?#]+)"', r.text):
                        if n not in names:
                            names.append(n)
                    for n in names:
                        if added_ol >= 15:
                            break
                        e = _dyn_from_ollama(n)
                        if e and _dyn_key(e) not in seen:
                            seen.add(_dyn_key(e))
                            collected.append(e)
                            added_ol += 1
                except Exception:
                    pass
            _refresh_step(collected)

            # 5. size the models the name-parser couldn't (from repo metadata)
            _refresh_phase("sizing unknowns")
            _enrich_unknown_sizes(client, collected)
            _refresh_step(collected)

        with REFRESH.lock:
            REFRESH.dynamic = collected
            REFRESH.updated = time.time()
            REFRESH.progress_at = time.time()
            REFRESH.state = "done"
            REFRESH.phase = f"added {len(collected)} models"
        _save_catalog_cache()
        _catlog("refresh DONE -- {} dynamic + {} static = {} total models "
                "served by /api/catalog".format(
                    len(collected), len(CATALOG), len(collected) + len(CATALOG)))
    except Exception as e:
        with REFRESH.lock:
            REFRESH.state, REFRESH.error = "error", f"{type(e).__name__}: {e}"
            REFRESH.phase = "refresh failed"
        _catlog("refresh FAILED: {}: {} -- {} dynamic collected before failure; "
                "static catalog still served".format(type(e).__name__, e, len(collected)))


# --------------------------------------------------------------------------
# HuggingFace backend (lazy -- torch/transformers only imported when used)
# --------------------------------------------------------------------------

class HFState:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = "idle"          # idle | loading | ready | error
        self.model_id: Optional[str] = None
        self.error: Optional[str] = None
        self.device: Optional[str] = None
        self.started: Optional[float] = None
        self.tokenizer = None
        self.model = None


HF = HFState()


def hf_available() -> bool:
    try:
        import torch  # noqa: F401
        import transformers  # noqa: F401
        return True
    except Exception:
        return False


def _hf_token() -> Optional[str]:
    """Optional HF access token from the environment. NOT required for public
    models -- only for gated/private repos. Ships loginless by default."""
    return (os.environ.get("HF_TOKEN")
            or os.environ.get("HUGGING_FACE_HUB_TOKEN")
            or os.environ.get("HUGGINGFACE_TOKEN"))


def _tf_version() -> str:
    try:
        import transformers
        return transformers.__version__
    except Exception:
        return "?"


def _hf_friendly_error(model_id: str, e: Exception) -> str:
    """Turn a raw transformers/hub exception into a clear, actionable message."""
    name = type(e).__name__
    msg = str(e)
    low = msg.lower()
    if any(s in low for s in ("gated repo", "gated model", "access to model",
                              "must be authenticated", "cannot access gated",
                              "awaiting a review", "401 client error",
                              "403 client error", "is restricted")):
        have = "a token IS set" if _hf_token() else "NO token is set"
        return (f"GATED: '{model_id}' needs (1) license acceptance at "
                f"https://huggingface.co/{model_id} and (2) a free HF access "
                f"token ({have}). Set HF_TOKEN before launching start.bat (see "
                f"README), then retry. Most models are public and need no login.")
    if ("does not recognize this architecture" in low
            or ("model type" in low and "not recognize" in low)
            or ("architecture" in low and "not support" in low)):
        return (f"'{model_id}' uses a very new architecture that the installed "
                f"transformers ({_tf_version()}) doesn't support yet. If a GGUF "
                f"build exists, pull it via Ollama instead (search the library for "
                f"the same name) -- that path handles brand-new models. No login "
                f"needed either way.")
    if "trust_remote_code" in low or "custom code" in low or "remote code" in low:
        return (f"'{model_id}' ships custom model code. Tick 'trust remote code' in "
                f"the drawer (only for repos you trust), then load again.")
    if (name in ("OutOfMemoryError",) or "out of memory" in low
            or "not enough memory" in low or "cuda error" in low):
        return (f"Ran out of memory loading '{model_id}'. Try the 4-bit checkbox, "
                f"pick a smaller model, or close other GPU apps.")
    if name == "ModuleNotFoundError" or "no module named" in low:
        return (f"'{model_id}' needs an extra package: {msg}. Some models require "
                f"e.g. sentencepiece or einops -- install it in the .venv.")
    if ("repository not found" in low or "404 client error" in low
            or "is not a valid model identifier" in low
            or "is not a local folder" in low):
        return (f"'{model_id}' was not found on HuggingFace -- check the exact repo "
                f"id (owner/name), it's case-sensitive.")
    return f"{name}: {msg}"


def _hf_load(model_id: str, four_bit: bool, trust_remote_code: bool = False) -> None:
    """Runs in a background thread; flips HF.state when done. Serialized against
    image/video loads (shared _MODEL_LOAD_LOCK) so two heavy loads never fight
    over VRAM."""
    from transformers import AutoModelForCausalLM, AutoTokenizer
    try:
      with _MODEL_LOAD_LOCK:
        common = {"trust_remote_code": trust_remote_code}
        token = _hf_token()
        if token:                       # only for opt-in gated access
            common["token"] = token
        kwargs = {"torch_dtype": "auto", "device_map": "auto", **common}
        if four_bit:
            from transformers import BitsAndBytesConfig
            kwargs["quantization_config"] = BitsAndBytesConfig(load_in_4bit=True)
        tok = AutoTokenizer.from_pretrained(model_id, **common)
        model = AutoModelForCausalLM.from_pretrained(model_id, **kwargs)
        with HF.lock:
            HF.tokenizer, HF.model = tok, model
            HF.state, HF.model_id = "ready", model_id
            HF.device = str(next(model.parameters()).device)
        _save_state(last_hf_model=model_id, last_hf_four_bit=four_bit,
                    last_hf_trust_remote_code=trust_remote_code)   # remember for auto-reload
    except Exception as e:  # surface anything (missing model, OOM, gated repo...)
        with HF.lock:
            HF.state, HF.error = "error", _hf_friendly_error(model_id, e)


def _hf_stream(messages, max_tokens: int, temperature: float):
    """Yield generated text pieces from the loaded HF model."""
    from transformers import TextIteratorStreamer

    tok, model = HF.tokenizer, HF.model
    # HF text path is text-only: drop any attached-image payloads
    messages = [{"role": m["role"], "content": m["content"]} for m in messages]
    if getattr(tok, "chat_template", None):
        input_ids = tok.apply_chat_template(
            messages, add_generation_prompt=True, return_tensors="pt"
        )
    else:  # base models without a chat template get a plain transcript
        prompt = "\n".join(f"{m['role']}: {m['content']}" for m in messages)
        input_ids = tok(prompt + "\nassistant:", return_tensors="pt").input_ids
    input_ids = input_ids.to(model.device)

    # transformers needs a positive cap; -1 / 0 (the UI's "unlimited") maps to a
    # generous ceiling so long/reasoning answers aren't clipped mid-sentence.
    max_new = max_tokens if (max_tokens and max_tokens > 0) else 4096
    streamer = TextIteratorStreamer(tok, skip_prompt=True, skip_special_tokens=True)
    gen_kwargs = dict(
        input_ids=input_ids,
        max_new_tokens=max_new,
        streamer=streamer,
        do_sample=temperature > 0,
        temperature=max(temperature, 1e-5),
        pad_token_id=tok.pad_token_id or tok.eos_token_id,
    )
    thread = threading.Thread(target=model.generate, kwargs=gen_kwargs, daemon=True)
    thread.start()
    yield from streamer


# --------------------------------------------------------------------------
# Image-generation backend (diffusers -- lazy, optional install)
# --------------------------------------------------------------------------

class ImgState:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = "idle"          # idle | loading | ready | error | busy
        self.model_id: Optional[str] = None
        self.error: Optional[str] = None
        self.device: Optional[str] = None
        self.started: Optional[float] = None
        self.pipe = None


IMG = ImgState()


def img_available() -> bool:
    try:
        import torch  # noqa: F401
        import diffusers  # noqa: F401
        return True
    except Exception:
        return False


# One heavy model may load at a time across ALL backends (HF chat + image +
# video). Concurrent loads fight over VRAM and die with OOM / "cannot copy out
# of meta tensor" on small cards; the load threads serialize on this lock so the
# actual GPU allocation is sequential even when the UI requests two at once.
_MODEL_LOAD_LOCK = threading.Lock()


def _is_oom(e: BaseException) -> bool:
    """True for a CUDA out-of-memory error (class or message), so callers can
    retry at a lighter offload tier instead of just failing."""
    name = type(e).__name__.lower()
    if "outofmemory" in name:
        return True
    msg = str(e).lower()
    return "out of memory" in msg or "cuda error: out of memory" in msg


def _offload_pipe(pipe, cuda: bool, other_loaded: bool, heavy: bool = False,
                  force: Optional[str] = None):
    """Apply a CPU-offload strategy and return (pipe, device). Both gen
    pipelines use this so a big model runs on a small card.

      * MODEL offload (`enable_model_cpu_offload`) is the default: weights live
        in system RAM and each whole module is streamed to the GPU only while it
        computes -- fast, and an idle pipeline barely uses VRAM.
      * SEQUENTIAL offload (`enable_sequential_cpu_offload`) is the heavy tier:
        submodule-granular, fits a model in ~2GB VRAM but is slower. We switch
        to it automatically when ANOTHER gen pipeline is already loaded on a
        modest card (<16GB), so image + video can coexist without running out of
        VRAM.

    `AEYE_OFFLOAD=sequential|model|none` forces a mode (none = straight to GPU)."""
    if not cuda:
        return pipe.to("cpu"), "cpu"
    import torch
    try:
        total_gb = torch.cuda.get_device_properties(0).total_memory / 1024**3
    except Exception:
        total_gb = 0.0
    forced = os.environ.get("AEYE_OFFLOAD", "").strip().lower()
    # an explicit override (used by the OOM auto-retry) wins over everything
    if force == "sequential":
        try:
            pipe.enable_sequential_cpu_offload()
            return pipe, "cuda"
        except Exception:
            pass
    # heavy models (SD3 / SD3.5 / FLUX carry a multi-GB T5 text encoder) do NOT
    # fit a small card without submodule-granular offload -- force sequential
    # there regardless of the requested mode, or the load/first generate OOMs
    # and the model appears to "refuse" to run.
    if heavy and total_gb and total_gb < 12 and forced != "sequential":
        try:
            pipe.enable_sequential_cpu_offload()
            return pipe, "cuda"
        except Exception:
            pass
    if forced == "none":
        try:
            return pipe.to("cuda"), "cuda"
        except Exception:
            return pipe.to("cpu"), "cpu"
    sequential = (forced == "sequential"
                  or (forced != "model" and (other_loaded or heavy) and total_gb < 16))
    try:
        if sequential:
            pipe.enable_sequential_cpu_offload()
        else:
            pipe.enable_model_cpu_offload()
    except Exception:
        try:
            return pipe.to("cuda"), "cuda"
        except Exception:
            return pipe.to("cpu"), "cpu"
    return pipe, "cuda"


def _img_load(model_id: str, force_offload: Optional[str] = None) -> None:
    """Load a text-to-image diffusers pipeline in a background thread. Serialized
    against HF/video loads (shared _MODEL_LOAD_LOCK). `force_offload='sequential'`
    is used by the OOM auto-retry to reload at the lightest VRAM tier."""
    try:
      with _MODEL_LOAD_LOCK:
        import torch
        from diffusers import AutoPipelineForText2Image

        cuda = torch.cuda.is_available()
        dtype = torch.float16 if cuda else torch.float32
        # safety_checker=None skips the NSFW CLIP checker -- it fails to load
        # against newer transformers (shape mismatch) and we don't want it here.
        base = dict(torch_dtype=dtype, safety_checker=None,
                    requires_safety_checker=False)
        token = _hf_token()             # optional, only for gated image repos
        if token:
            base["token"] = token
        # default layout works for most repos (SD1.5/2.1, SDXL, Playground);
        # some (sd-turbo, flux) publish fp16-variant weights, so fall back to
        # that if the default fails.
        attempts = ([base, {**base, "variant": "fp16"}]
                    if cuda else [base])
        pipe, last_err = None, None
        for kw in attempts:
            try:
                pipe = AutoPipelineForText2Image.from_pretrained(model_id, **kw)
                break
            except Exception as e:
                last_err = e
        if pipe is None:
            raise last_err
        # SD3/SD3.5/FLUX carry a huge T5 text encoder -> need submodule offload
        # on a small card, else they OOM instead of generating
        mid = model_id.lower()
        heavy = any(k in mid for k in
                    ("stable-diffusion-3", "sd3", "sd-3.5", "flux", "cogview"))
        # heavier offload if a video pipeline is already occupying the card
        pipe, device = _offload_pipe(
            pipe, cuda, VID.state in ("loading", "ready", "busy"),
            heavy=heavy, force=force_offload)
        try:
            pipe.set_progress_bar_config(disable=True)
        except Exception:
            pass
        with IMG.lock:
            IMG.pipe, IMG.state, IMG.model_id, IMG.device = pipe, "ready", model_id, device
        _save_state(last_image_model=model_id)   # remember for auto-reload
    except Exception as e:
        with IMG.lock:
            IMG.state, IMG.error = "error", _hf_friendly_error(model_id, e)


def _img_generate(prompt: str, negative: str, steps: int, guidance: float,
                  width: int, height: int, seed: Optional[int]) -> str:
    """Run the loaded pipeline and return a base64 PNG data URL."""
    import base64
    import io

    import torch

    gen = None
    if seed is not None and seed >= 0:
        dev = "cuda" if IMG.device == "cuda" else "cpu"
        gen = torch.Generator(device=dev).manual_seed(int(seed))
    kwargs = dict(prompt=prompt, num_inference_steps=int(steps),
                  guidance_scale=float(guidance),
                  width=int(width), height=int(height))
    if negative:
        kwargs["negative_prompt"] = negative
    if gen is not None:
        kwargs["generator"] = gen
    image = IMG.pipe(**kwargs).images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


# --------------------------------------------------------------------------
# Video-generation backend ("dream" -- diffusers text-to-video, lazy/optional).
# Mirrors the image pipeline: same lazy load, VRAM-thrifty offload, and a
# separate state so it never fights the chat/image models (loads stay strictly
# sequential). Output is an mp4 (via diffusers export_to_video when a codec
# backend is present) or an animated GIF fallback (PIL only, no extra dep).
# --------------------------------------------------------------------------

class VidState:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = "idle"          # idle | loading | ready | error | busy
        self.model_id: Optional[str] = None
        self.error: Optional[str] = None
        self.device: Optional[str] = None
        self.started: Optional[float] = None
        self.pipe = None


VID = VidState()

# SD1.5 base an AnimateDiff motion-adapter repo is mounted on (adapters aren't
# standalone pipelines). Overridable; defaults to the community SD1.5 re-host
# that's already in the catalog.
_ANIMATEDIFF_BASE = os.environ.get(
    "AEYE_ANIMATEDIFF_BASE", "stable-diffusion-v1-5/stable-diffusion-v1-5")


def vid_available() -> bool:
    try:
        import torch  # noqa: F401
        import diffusers  # noqa: F401
        return True
    except Exception:
        return False


def _vid_load(model_id: str, force_offload: Optional[str] = None) -> None:
    """Load a text-to-video diffusers pipeline in a background thread. Most T2V
    repos (ModelScope/zeroscope/LTX/CogVideoX/Wan/Mochi) load straight through
    DiffusionPipeline; AnimateDiff is special-cased (motion adapter + SD1.5
    base + a DDIM scheduler). Serialized against HF/image loads
    (shared _MODEL_LOAD_LOCK); `force_offload='sequential'` is the OOM retry."""
    try:
      with _MODEL_LOAD_LOCK:
        import torch

        cuda = torch.cuda.is_available()
        dtype = torch.float16 if cuda else torch.float32
        token = _hf_token()                 # optional, only for gated repos
        low = model_id.lower()

        if "animatediff" in low or "motion-adapter" in low or "motion_adapter" in low:
            from diffusers import AnimateDiffPipeline, MotionAdapter, DDIMScheduler
            akw = {"torch_dtype": dtype}
            if token:
                akw["token"] = token
            adapter = MotionAdapter.from_pretrained(model_id, **akw)
            bkw = {"torch_dtype": dtype, "motion_adapter": adapter}
            if token:
                bkw["token"] = token
            pipe = AnimateDiffPipeline.from_pretrained(_ANIMATEDIFF_BASE, **bkw)
            pipe.scheduler = DDIMScheduler.from_config(
                pipe.scheduler.config, beta_schedule="linear", clip_sample=False,
                timestep_spacing="linspace", steps_offset=1)
        else:
            from diffusers import DiffusionPipeline
            kw = {"torch_dtype": dtype}
            if token:
                kw["token"] = token
            pipe = DiffusionPipeline.from_pretrained(model_id, **kw)

        # heavier offload if an image pipeline is already occupying the card
        vheavy = any(k in model_id.lower() for k in
                     ("cogvideo", "mochi", "ltx", "hunyuan", "wan"))
        pipe, device = _offload_pipe(
            pipe, cuda, IMG.state in ("loading", "ready", "busy"),
            heavy=vheavy, force=force_offload)
        # video is VRAM-hungry -- shave the VAE where the pipeline supports it
        for opt in ("enable_vae_slicing", "enable_vae_tiling"):
            try:
                getattr(pipe, opt)()
            except Exception:
                pass
        try:
            pipe.set_progress_bar_config(disable=True)
        except Exception:
            pass
        with VID.lock:
            VID.pipe, VID.state, VID.model_id, VID.device = pipe, "ready", model_id, device
        _save_state(last_video_model=model_id)   # remember for auto-reload
    except Exception as e:
        with VID.lock:
            VID.state, VID.error = "error", _hf_friendly_error(model_id, e)


def _vid_encode(frames, fps: int) -> tuple:
    """Frames (PIL or ndarray) -> (data URL, mime). Prefer mp4 via diffusers'
    export_to_video; if no codec backend is installed, fall back to an animated
    GIF written with PIL alone (so video works even without imageio/opencv)."""
    import base64

    from PIL import Image
    import numpy as np

    pil = []
    for f in frames:
        if isinstance(f, Image.Image):
            pil.append(f)
        else:
            arr = np.asarray(f)
            if arr.dtype != np.uint8:
                arr = (arr * 255).clip(0, 255).astype("uint8")
            pil.append(Image.fromarray(arr))

    tmpdir = tempfile.mkdtemp()
    try:
        try:
            from diffusers.utils import export_to_video
            mp4 = os.path.join(tmpdir, "out.mp4")
            export_to_video(pil, mp4, fps=int(fps))
            with open(mp4, "rb") as f:
                data = f.read()
            return "data:video/mp4;base64," + base64.b64encode(data).decode(), "video/mp4"
        except Exception:
            gif = os.path.join(tmpdir, "out.gif")
            dur = max(1, int(1000 / max(1, int(fps))))
            pil[0].save(gif, save_all=True, append_images=pil[1:],
                        duration=dur, loop=0, optimize=True)
            with open(gif, "rb") as f:
                data = f.read()
            return "data:image/gif;base64," + base64.b64encode(data).decode(), "image/gif"
    finally:
        try:
            shutil.rmtree(tmpdir)
        except Exception:
            pass


def _vid_generate(prompt: str, negative: str, steps: int, guidance: float,
                  num_frames: int, fps: int, width: int, height: int,
                  seed: Optional[int]) -> tuple:
    """Run the loaded video pipeline and return (data URL, mime). Only the
    kwargs the specific pipeline accepts are passed (their signatures differ)."""
    import inspect

    import torch

    gen = None
    if seed is not None and seed >= 0:
        dev = "cuda" if VID.device == "cuda" else "cpu"
        gen = torch.Generator(device=dev).manual_seed(int(seed))

    params = inspect.signature(VID.pipe.__call__).parameters
    kwargs = {"prompt": prompt, "num_inference_steps": int(steps),
              "guidance_scale": float(guidance)}
    if "num_frames" in params:
        kwargs["num_frames"] = int(num_frames)
    if negative and "negative_prompt" in params:
        kwargs["negative_prompt"] = negative
    if gen is not None and "generator" in params:
        kwargs["generator"] = gen
    if width and "width" in params:
        kwargs["width"] = int(width)
    if height and "height" in params:
        kwargs["height"] = int(height)

    result = VID.pipe(**kwargs)
    frames = result.frames[0] if hasattr(result, "frames") else result[0]
    return _vid_encode(frames, fps)


# --------------------------------------------------------------------------
# Piper text-to-speech backend (local neural voices, optional install)
# --------------------------------------------------------------------------

PIPER_REPO = "rhasspy/piper-voices"

# a curated slice of the piper-voices catalog; `path` is the folder inside the
# HF repo, the files are <key>.onnx and <key>.onnx.json.
PIPER_VOICES = [
    {"key": "en_US-lessac-medium",   "accent": "English (US)", "quality": "medium", "size_mb": 63,  "path": "en/en_US/lessac/medium",   "note": "clear, neutral"},
    {"key": "en_US-amy-medium",      "accent": "English (US)", "quality": "medium", "size_mb": 63,  "path": "en/en_US/amy/medium",      "note": "female"},
    {"key": "en_US-ryan-high",       "accent": "English (US)", "quality": "high",   "size_mb": 114, "path": "en/en_US/ryan/high",       "note": "male, high quality"},
    {"key": "en_US-hfc_female-medium", "accent": "English (US)", "quality": "medium", "size_mb": 63, "path": "en/en_US/hfc_female/medium", "note": "female"},
    {"key": "en_US-hfc_male-medium", "accent": "English (US)", "quality": "medium", "size_mb": 63,  "path": "en/en_US/hfc_male/medium",  "note": "male"},
    {"key": "en_US-libritts_r-medium", "accent": "English (US)", "quality": "medium", "size_mb": 76, "path": "en/en_US/libritts_r/medium", "note": "expressive"},
    {"key": "en_GB-alan-medium",     "accent": "English (UK)", "quality": "medium", "size_mb": 63,  "path": "en/en_GB/alan/medium",     "note": "male"},
    {"key": "en_GB-cori-high",       "accent": "English (UK)", "quality": "high",   "size_mb": 114, "path": "en/en_GB/cori/high",       "note": "female, high quality"},
    {"key": "en_GB-jenny_dioco-medium", "accent": "English (UK)", "quality": "medium", "size_mb": 63, "path": "en/en_GB/jenny_dioco/medium", "note": "female"},
    # --- more voices / characterful accents ---
    {"key": "en_US-joe-medium",      "accent": "English (US)", "quality": "medium", "size_mb": 63,  "path": "en/en_US/joe/medium",      "note": "male, warm"},
    {"key": "en_US-norman-medium",   "accent": "English (US)", "quality": "medium", "size_mb": 64,  "path": "en/en_US/norman/medium",   "note": "male, deep"},
    {"key": "en_US-kusal-medium",    "accent": "English (US)", "quality": "medium", "size_mb": 63,  "path": "en/en_US/kusal/medium",    "note": "male"},
    {"key": "en_US-bryce-medium",    "accent": "English (US)", "quality": "medium", "size_mb": 64,  "path": "en/en_US/bryce/medium",    "note": "male"},
    {"key": "en_US-john-medium",     "accent": "English (US)", "quality": "medium", "size_mb": 64,  "path": "en/en_US/john/medium",     "note": "male"},
    {"key": "en_US-kristin-medium",  "accent": "English (US)", "quality": "medium", "size_mb": 64,  "path": "en/en_US/kristin/medium",  "note": "female"},
    {"key": "en_US-sam-medium",      "accent": "English (US)", "quality": "medium", "size_mb": 63,  "path": "en/en_US/sam/medium",      "note": "male"},
    {"key": "en_US-danny-low",       "accent": "English (US)", "quality": "low",    "size_mb": 63,  "path": "en/en_US/danny/low",       "note": "male, fast/light"},
    {"key": "en_GB-alba-medium",     "accent": "Scottish",     "quality": "medium", "size_mb": 63,  "path": "en/en_GB/alba/medium",     "note": "female, Scottish accent"},
    {"key": "en_GB-northern_english_male-medium", "accent": "N. English", "quality": "medium", "size_mb": 63, "path": "en/en_GB/northern_english_male/medium", "note": "male, Yorkshire-ish"},
    {"key": "en_GB-southern_english_female-low", "accent": "S. English", "quality": "low", "size_mb": 63, "path": "en/en_GB/southern_english_female/low", "note": "female"},
    {"key": "en_US-ryan-medium",     "accent": "English (US)", "quality": "medium", "size_mb": 63,  "path": "en/en_US/ryan/medium",     "note": "male"},
]
PIPER_INDEX = {v["key"]: v for v in PIPER_VOICES}
# fetched automatically on first run so TTS works out of the box (matches the
# old install.bat behavior); override with AEYE_DEFAULT_VOICE.
DEFAULT_VOICE = os.environ.get("AEYE_DEFAULT_VOICE", "en_US-danny-low")

# Fun voice-effect presets applied to any Piper voice as post-processing:
# (pitch, length_scale_mul). pitch<1 = deeper+slower, pitch>1 = higher+faster;
# length_scale_mul tweaks the synth speed to give each character its cadence.
TTS_EFFECTS = {
    "normal":   (1.00, 1.00),
    "goblin":   (0.80, 0.92),   # gnarly, deep, a touch quick
    "demon":    (0.66, 1.12),   # very deep and slow
    "giant":    (0.82, 1.22),   # big, booming, ponderous
    "troll":    (0.74, 1.05),   # dumb-brute low
    "chipmunk": (1.55, 1.32),   # squeaky, high
    "sprite":   (1.28, 1.08),   # light pixie
    "gremlin":  (1.40, 0.90),   # high and fast, mischievous
}

# Horror effect chains (Spotify's pedalboard). Each preset is a real DSP chain:
#   pitch     semitones down (inhuman depth, high-quality PitchShift)
#   ring      ring-mod carrier Hz + mix (the "corrupted machine"/Dalek buzz)
#   detune    a duplicated layer shifted this many cents + mix ("many voices")
#   bitcrush  bit depth (lower = grittier, degraded-recording texture)
#   drive     distortion drive dB
#   hp/lp     high/low-pass cutoffs (intercom bandlimiting)
#   reverb    room size + wet (dark facility/intercom space)
#   ls        Piper length-scale mult (>1 = slower, creepier cadence)
HORROR_EFFECTS = {
    "dalek":     {"pitch": -3, "ring": 50, "ring_mix": 0.65, "drive": 6,
                  "reverb": 0.15, "wet": 0.2, "ls": 1.06},
    "possessed": {"pitch": -4, "detune": 28, "detune_mix": 0.55, "drive": 4,
                  "lp": 5200, "reverb": 0.35, "wet": 0.35, "ls": 1.12},
    "corrupted": {"pitch": -5, "ring": 60, "ring_mix": 0.5, "bitcrush": 7,
                  "drive": 9, "reverb": 0.1, "wet": 0.15, "ls": 1.08},
    # radio-demon: corrupted, but a hard digital broadcast -- ring-mod demon
    # voice squeezed through a bandlimited, bit-crushed radio channel, peppered
    # with random data-beeps and signal dropouts.
    "radiodemon": {"pitch": -4, "ring": 42, "ring_mix": 0.38, "bitcrush": 5,
                   "drive": 8, "hp": 340, "lp": 3200, "reverb": 0.12, "wet": 0.14,
                   # beep count/dropouts come from the drawer's beep slider
                   "beeps": {"level": 0.16, "fmin": 850, "fmax": 2600}, "ls": 1.06},
    "intercom":  {"pitch": -1, "hp": 500, "lp": 2800, "bitcrush": 8, "drive": 12,
                  "reverb": 0.25, "wet": 0.3, "ls": 1.0},
    "wraith":    {"pitch": -5, "detune": 35, "detune_mix": 0.6, "lp": 4200,
                  "reverb": 0.55, "wet": 0.5, "ls": 1.15},
    "hive":      {"pitch": -3, "detune": 42, "detune_mix": 0.7, "ring": 34,
                  "ring_mix": 0.28, "reverb": 0.3, "wet": 0.3, "ls": 1.05},
}


class PiperState:
    def __init__(self):
        self.lock = threading.Lock()
        self.cache = {}              # onnx_path -> loaded PiperVoice
        self.dl_state = "idle"       # idle | downloading | ready | error
        self.dl_key: Optional[str] = None
        self.dl_error: Optional[str] = None
        self.dl_started: Optional[float] = None


PIPER = PiperState()


def piper_available() -> bool:
    try:
        import piper  # noqa: F401
        return True
    except Exception:
        return shutil.which("piper") is not None


def _piper_files(key: str, download: bool):
    """Return (onnx_path, config_path) for a voice, or None if not local.

    When download is False we only look in the local HF cache.
    """
    from huggingface_hub import hf_hub_download
    v = PIPER_INDEX[key]
    onnx = f"{v['path']}/{key}.onnx"
    cfg = onnx + ".json"
    kw = {} if download else {"local_files_only": True}
    op = hf_hub_download(PIPER_REPO, onnx, **kw)
    cp = hf_hub_download(PIPER_REPO, cfg, **kw)
    return op, cp


def _piper_is_local(key: str) -> bool:
    try:
        _piper_files(key, download=False)
        return True
    except Exception:
        return False


def _piper_download(key: str) -> None:
    try:
        _piper_files(key, download=True)
        with PIPER.lock:
            PIPER.dl_state = "ready"
    except Exception as e:
        with PIPER.lock:
            PIPER.dl_state, PIPER.dl_error = "error", f"{type(e).__name__}: {e}"


def _ensure_default_voice() -> None:
    """First-run convenience: fetch the default Piper voice if Piper is present
    and it isn't cached yet. Best-effort and ONLINE-only -- offline, or if Piper
    is missing, it silently does nothing (the user can grab any voice from the
    TTS drawer). No-ops on every subsequent boot once the voice is local."""
    try:
        if not piper_available() or _piper_is_local(DEFAULT_VOICE):
            return
        # download quietly WITHOUT taking the shared PIPER.dl_state slot, so a
        # user can still download a different voice from the TTS drawer while
        # this runs (huggingface_hub file-locks concurrent fetches of the same
        # files, so overlap with a user-initiated default download is safe)
        _piper_files(DEFAULT_VOICE, download=True)
    except Exception:
        pass


def pedalboard_available() -> bool:
    try:
        import numpy  # noqa: F401
        import pedalboard  # noqa: F401
        return True
    except Exception:
        return False


def _wav_to_np(wav_bytes):
    """WAV bytes -> (mono float32 in [-1,1], sample_rate)."""
    import io
    import wave

    import numpy as np
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
        frames = w.readframes(w.getnframes())
    dtype = {1: np.int8, 2: np.int16, 4: np.int32}.get(sw, np.int16)
    arr = np.frombuffer(frames, dtype=dtype).astype(np.float32)
    arr /= float(np.iinfo(dtype).max)
    if ch > 1:
        arr = arr.reshape(-1, ch).mean(axis=1)
    return arr, sr


def _np_to_wav(samples, sr):
    import io
    import wave

    import numpy as np
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(int(sr))
        w.writeframes(pcm.tobytes())
    return buf.getvalue()


def _inject_beeps(x, sr, count=0, dropout_count=0, level=0.16, fmin=700,
                  fmax=2500, dmin=30, dmax=140, square=0.45):
    """Sprinkle `count` random digital data-beeps (+ `dropout_count` brief signal
    dropouts) into the signal for that corrupted-transmission / radio texture."""
    import numpy as np
    n = len(x)
    if n < 8 or (count <= 0 and dropout_count <= 0):
        return x
    rng = np.random.default_rng()
    out = x.copy()

    for _ in range(max(0, int(count))):
        blen = int(sr * rng.uniform(dmin, dmax) / 1000.0)
        if blen < 4:
            continue
        start = int(rng.integers(0, max(1, n - blen)))
        t = np.arange(blen, dtype=np.float32) / sr
        tone = np.sin(2.0 * np.pi * float(rng.uniform(fmin, fmax)) * t).astype(np.float32)
        if rng.random() < square:               # square-ish -> more digital
            tone = np.sign(tone) * 0.7
        env = np.ones(blen, dtype=np.float32)    # de-click fade in/out
        a = min(max(1, int(0.006 * sr)), blen // 2)
        if a > 0:
            env[:a] = np.linspace(0.0, 1.0, a)
            env[-a:] = np.linspace(1.0, 0.0, a)
        out[start:start + blen] += level * tone * env

    for _ in range(max(0, int(dropout_count))):   # brief signal loss
        dlen = int(sr * rng.uniform(20, 90) / 1000.0)
        if dlen < 2:
            continue
        start = int(rng.integers(0, max(1, n - dlen)))
        out[start:start + dlen] *= 0.03
    return out


def _horror_process(wav_bytes: bytes, preset: str, beep_count: int = 0,
                    dropout_count: int = 0) -> bytes:
    """Run a Piper WAV through a pedalboard horror chain -> WAV bytes."""
    import numpy as np
    from pedalboard import (Bitcrush, Distortion, HighpassFilter,
                            LowpassFilter, Pedalboard, PitchShift, Reverb)

    p = HORROR_EFFECTS[preset]
    x, sr = _wav_to_np(wav_bytes)

    # digital beeps / dropouts injected pre-chain so they share the channel
    # (get bandlimited + crushed + reverbed with the voice)
    if p.get("beeps") and (beep_count > 0 or dropout_count > 0):
        x = _inject_beeps(x, sr, count=beep_count, dropout_count=dropout_count,
                          **p["beeps"])

    # detuned duplicate layer -> "several voices at once" wrongness
    if p.get("detune"):
        layer = PitchShift(semitones=p["detune"] / 100.0)(x, sr)
        m = min(len(layer), len(x))
        mix = p.get("detune_mix", 0.5)
        x = x.copy()
        x[:m] = (1.0 - mix) * x[:m] + mix * layer[:m]

    # ring modulation -> corrupted-machine / Dalek buzz
    if p.get("ring"):
        t = np.arange(len(x), dtype=np.float32) / sr
        carrier = np.sin(2.0 * np.pi * p["ring"] * t).astype(np.float32)
        rm = p.get("ring_mix", 0.6)
        x = (1.0 - rm) * x + rm * (x * carrier)

    chain = []
    if p.get("pitch"):
        chain.append(PitchShift(semitones=float(p["pitch"])))
    if p.get("hp"):
        chain.append(HighpassFilter(cutoff_frequency_hz=float(p["hp"])))
    if p.get("lp"):
        chain.append(LowpassFilter(cutoff_frequency_hz=float(p["lp"])))
    if p.get("drive"):
        chain.append(Distortion(drive_db=float(p["drive"])))
    if p.get("bitcrush"):
        chain.append(Bitcrush(bit_depth=int(p["bitcrush"])))
    if p.get("reverb"):
        chain.append(Reverb(room_size=float(p["reverb"]),
                            wet_level=float(p.get("wet", 0.3)),
                            dry_level=1.0 - float(p.get("wet", 0.3))))
    out = Pedalboard(chain)(x.astype(np.float32), sr) if chain else x

    peak = float(np.max(np.abs(out))) or 1.0
    if peak > 1.0:                       # tame clipping from stacked gain/reverb
        out = out / peak * 0.98
    return _np_to_wav(out, sr)


def _apply_pitch(wav_bytes: bytes, pitch: float) -> bytes:
    """Cheap, dependency-free pitch shift: reinterpret the WAV sample rate.
    pitch>1 = higher & faster, pitch<1 = deeper & slower. Great for the fun
    goblin/chipmunk/demon presets; the synth length_scale sets the cadence."""
    if not pitch or abs(pitch - 1.0) < 1e-3:
        return wav_bytes
    import io
    import wave
    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as w:
            n, ch, sw, fr = (w.getnframes(), w.getnchannels(),
                             w.getsampwidth(), w.getframerate())
            frames = w.readframes(n)
        out = io.BytesIO()
        with wave.open(out, "wb") as w:
            w.setnchannels(ch)
            w.setsampwidth(sw)
            w.setframerate(max(4000, int(fr * pitch)))
            w.writeframes(frames)
        return out.getvalue()
    except Exception:
        return wav_bytes


def _pad_wav_silence(wav_bytes: bytes, lead_ms: int = 200, tail_ms: int = 250) -> bytes:
    """Pad silence at both ends. Browsers clip the edges of a short WAV played
    from a blob URL: the start (playback ramps up after .play(), eating the
    first word) and the end (final buffer dropped, eating the last word).
    Padding silence means the browser trims silence, not speech."""
    if lead_ms <= 0 and tail_ms <= 0:
        return wav_bytes
    import io
    import wave
    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as w:
            n, ch, sw, fr = (w.getnframes(), w.getnchannels(),
                             w.getsampwidth(), w.getframerate())
            frames = w.readframes(n)

        def silence(ms):
            return b"\x00" * (int(fr * max(ms, 0) / 1000) * ch * sw)

        out = io.BytesIO()
        with wave.open(out, "wb") as w:
            w.setnchannels(ch)
            w.setsampwidth(sw)
            w.setframerate(fr)
            w.writeframes(silence(lead_ms) + frames + silence(tail_ms))
        return out.getvalue()
    except Exception:
        return wav_bytes


def _silent_wav(ms: int = 40, sr: int = 22050) -> bytes:
    """A valid short mono silent WAV -- used for chunks with nothing to say."""
    import io
    import wave
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"\x00" * (int(sr * max(ms, 1) / 1000) * 2))
    return buf.getvalue()


def _piper_synth(key: str, text: str, length_scale: float,
                 effect: str = "normal", lead_ms: int = 200,
                 tail_ms: int = 250, terminal_punct: bool = True,
                 beep_words: int = 0) -> bytes:
    """Synthesize `text` to WAV bytes with the given voice + optional effect."""
    import random
    import re
    import io
    import wave

    is_horror = (effect in HORROR_EFFECTS) and pedalboard_available()
    if is_horror:
        pitch, ls_mul = 1.0, HORROR_EFFECTS[effect].get("ls", 1.0)
    else:
        pitch, ls_mul = TTS_EFFECTS.get(effect or "normal", (1.0, 1.0))
    length_scale = (length_scale or 1.0) * ls_mul

    # A terminal mark helps Piper finish the last word, but it also gives the
    # chunk phrase-final "this is the end" prosody -- undesirable for a mid-
    # phrase word-run that should flow into the next (the shuffle mode).
    text = text.rstrip()
    # Piper writes no audio for a chunk with nothing to voice (punctuation /
    # symbols only), which then fails to close the WAV ("# channels not
    # specified"). Return a brief silence so streaming just skips over it.
    if not re.search(r"[^\W_]", text, re.UNICODE):
        return _silent_wav(max(1, lead_ms + tail_ms))
    word_count = len(text.split())
    if terminal_punct and text and text[-1].isalnum():
        text += "."

    # "beep every N words" -> a fractional expected count for this chunk, so the
    # density stays right even across tiny word-runs. 0 (or less) means off.
    beep_count = 0
    if beep_words and beep_words > 0 and word_count:
        exact = word_count / beep_words
        beep_count = int(exact) + (1 if random.random() < (exact - int(exact)) else 0)
    dropout_count = round(beep_count * 0.5)

    onnx, cfg = _piper_files(key, download=False)

    def finish(wav):
        padded = _pad_wav_silence(wav, lead_ms, tail_ms)
        if is_horror:
            return _horror_process(padded, effect, beep_count, dropout_count)
        return _apply_pitch(padded, pitch)

    # prefer the python package; fall back to the piper binary
    try:
        from piper import PiperVoice
    except Exception:
        return finish(_piper_synth_binary(onnx, cfg, text, length_scale))

    with PIPER.lock:
        voice = PIPER.cache.get(onnx)
    if voice is None:
        voice = PiperVoice.load(onnx, cfg)
        with PIPER.lock:
            PIPER.cache[onnx] = voice

    buf = io.BytesIO()
    wf = wave.open(buf, "wb")
    try:
        # newer piper (>=1.3): synthesize_wav, optional SynthesisConfig
        try:
            from piper import SynthesisConfig
            sc = SynthesisConfig(length_scale=length_scale) if length_scale else None
            if sc is not None:
                voice.synthesize_wav(text, wf, syn_config=sc)
            else:
                voice.synthesize_wav(text, wf)
        except ImportError:
            voice.synthesize_wav(text, wf)
    except AttributeError:
        # older piper: synthesize(text, wave_file, length_scale=...)
        try:
            voice.synthesize(text, wf, length_scale=length_scale)
        except TypeError:
            voice.synthesize(text, wf)
    finally:
        try:
            wf.close()
        except Exception:
            buf = None      # no audio was produced -> fall back to silence
    return finish(buf.getvalue()) if buf is not None else _silent_wav(max(1, lead_ms + tail_ms))


def _piper_synth_binary(onnx: str, cfg: str, text: str, length_scale: float) -> bytes:
    """Fallback: drive the standalone piper.exe binary."""
    fd, out = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    try:
        cmd = ["piper", "-m", onnx, "-c", cfg, "-f", out]
        if length_scale:
            cmd += ["--length_scale", str(length_scale)]
        # timeout so a hung piper.exe can't block the TTS worker thread forever
        try:
            subprocess.run(cmd, input=text, text=True, check=True,
                           creationflags=NOWIN, capture_output=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise RuntimeError("piper.exe timed out")
        with open(out, "rb") as f:
            return f.read()
    finally:
        try:
            os.remove(out)
        except OSError:
            pass


# --------------------------------------------------------------------------
# API models
# --------------------------------------------------------------------------

class ChatReq(BaseModel):
    backend: str                     # "ollama" | "hf"
    model: Optional[str] = None
    messages: list
    temperature: float = 0.7
    max_tokens: int = -1            # default unlimited (until EOS / context fills)
    num_ctx: int = 16384             # Ollama context window (prompt + reply)


class HFLoadReq(BaseModel):
    model_id: str
    four_bit: bool = False
    trust_remote_code: bool = False


class PullReq(BaseModel):
    name: str


class ShowReq(BaseModel):
    name: str


class CreateReq(BaseModel):
    name: str
    modelfile: str


class ImgLoadReq(BaseModel):
    model_id: str


class ImgGenReq(BaseModel):
    prompt: str
    negative: str = ""
    steps: int = 30
    guidance: float = 7.0
    width: int = 512
    height: int = 512
    seed: Optional[int] = None


class VidLoadReq(BaseModel):
    model_id: str


class VidGenReq(BaseModel):
    prompt: str
    negative: str = ""
    steps: int = 25
    guidance: float = 7.0
    num_frames: int = 16
    fps: int = 8
    width: int = 0             # 0 -> let the pipeline use its native size
    height: int = 0
    seed: Optional[int] = None


class AutoloadReq(BaseModel):
    chat: bool = False
    image: bool = False
    video: bool = False


class TTSDownloadReq(BaseModel):
    key: str


class TTSSpeakReq(BaseModel):
    key: str
    text: str
    length_scale: float = 1.0
    effect: str = "normal"
    stream: bool = False            # mid-stream chunk: play via Web Audio (no
    #                                 start-clip), so trim padding to a short
    #                                 natural inter-sentence pause.
    flow: bool = False              # a mid-PHRASE word-run (shuffle mode): no
    #                                 sentence prosody, minimal tail, so runs
    #                                 flow seamlessly into each other.
    beep_words: int = 0             # radiodemon data-beeps: one every N words
    #                                 (0 = off). Only used by beep-capable presets.


class HFDeleteReq(BaseModel):
    repo: str


class OpenPageReq(BaseModel):
    url: str


@app.post("/api/open")
def open_page(req: OpenPageReq):
    """Open a URL in the system's default browser -- the desktop window has no
    tabs, so external pages must leave the webview. Used by model-page links and
    the web tool's clickable source citations. Restricted to http/https so no
    file:/custom-protocol handler can be launched; the click is always user-
    initiated, and server == client on a local app so it opens the user's own
    browser."""
    url = (req.url or "").strip()
    low = url.lower()
    if not (low.startswith("http://") or low.startswith("https://")):
        return {"ok": False, "error": "only http/https URLs can be opened"}
    import webbrowser
    webbrowser.open(url)
    return {"ok": True}


# --------------------------------------------------------------------------
# Installed / downloaded inventory (for the de-bloat trashcan)
# --------------------------------------------------------------------------

def _ollama_installed():
    """Installed Ollama models with on-disk sizes, biggest first."""
    try:
        with httpx.Client(timeout=4) as client:
            r = client.get(f"{OLLAMA}/api/tags")
        out = [{"name": m["name"], "size_gb": round(m.get("size", 0) / 2**30, 2)}
               for m in r.json().get("models", [])]
        out.sort(key=lambda x: x["size_gb"], reverse=True)
        return out, True
    except Exception:
        return [], False


_VID_PIPE_HINTS = ("video", "animatediff", "ltx", "wan", "mochi", "cogvideo")


def _repo_kind(r) -> str:
    """'video' / 'image' if the cached snapshot looks like a diffusers pipeline
    (has model_index.json -- the pipeline's `_class_name` tells video from
    image), else 'llm'. Lets the UI offer the right load button for a repo that
    isn't in the curated catalog."""
    try:
        for rev in r.revisions:
            for f in rev.files:
                if getattr(f, "file_name", "") == "model_index.json":
                    try:
                        with open(os.path.join(str(rev.snapshot_path),
                                               "model_index.json"),
                                  encoding="utf-8") as fh:
                            cls = (json.load(fh).get("_class_name") or "").lower()
                        if any(h in cls for h in _VID_PIPE_HINTS):
                            return "video"
                    except Exception:
                        pass
                    # repo id is another signal (adapters have no telltale class)
                    if any(h in r.repo_id.lower() for h in _VID_PIPE_HINTS):
                        return "video"
                    return "image"
    except Exception:
        pass
    return "llm"


def _hf_cache_repos():
    """Cached HuggingFace model repos with on-disk sizes (voices excluded --
    those are managed from the voice picker)."""
    try:
        from huggingface_hub import scan_cache_dir
        cache = scan_cache_dir()
    except Exception as e:
        return [], 0.0, f"{type(e).__name__}: {e}"
    repos = []
    for r in cache.repos:
        if r.repo_type != "model" or r.repo_id == PIPER_REPO:
            continue
        repos.append({"repo": r.repo_id,
                      "size_gb": round(r.size_on_disk / 2**30, 2),
                      "kind": _repo_kind(r),
                      "loaded": (HF.model_id == r.repo_id
                                 or IMG.model_id == r.repo_id
                                 or VID.model_id == r.repo_id)})
    repos.sort(key=lambda x: x["size_gb"], reverse=True)
    return repos, round(cache.size_on_disk / 2**30, 2), None


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------

@app.get("/")
def index():
    return FileResponse(os.path.join(ROOT, "static", "index.html"))


@app.get("/api/version")
def version():
    """App version + whether the optional AI-extras venv is present, for the UI."""
    return {"version": __version__,
            "frozen": paths.FROZEN,
            "extras": os.path.isdir(
                os.path.join(paths.EXTRAS_DIR, "Lib", "site-packages"))}


@app.get("/api/skull")
def skull_txt():
    """The root skull.txt (also the installer banner), reused by skull.js as
    the hidden-eye chat backdrop. no-cache: the WebView2 stale-JS gotcha."""
    return FileResponse(os.path.join(ROOT, "skull.txt"),
                        media_type="text/plain; charset=utf-8",
                        headers={"Cache-Control": "no-cache"})


# --------------------------------------------------------------------------
# Plugins: run a local tool (a repo you dropped in ./plugins) and stream its
# output into chat. Each plugin is a folder with an `aeye-plugin.json`
# manifest declaring the argv command to run. This is arbitrary LOCAL code
# execution BY DESIGN -- the whole point is to wire your own tools in -- so
# the guardrails are about making it deliberate and un-hijackable, not about
# sandboxing what you chose to install:
#   * plugins fire ONLY from an explicit composer submit (chat.js), never
#     from model output / memory / docs -- a model can't type a trigger to
#     run code.
#   * the command is author-declared in a manifest you can read, and the UI
#     shows the exact argv before you run it.
#   * the user's query is passed as argv items (no shell=True, no string
#     splitting), so it can't inject extra arguments or a second command.
#   * the plugin id is validated + confined to ./plugins (no traversal).
# Manifest: {name, trigger, description?, command:[argv...], cwd?, timeout?}
# `{query}` in any argv item is replaced by the text after the trigger.
# --------------------------------------------------------------------------

PLUGINS_DIR = paths.PLUGINS_DIR
_PLUGIN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_PLUGIN_MAX_LINE = 4000          # clamp a runaway single line of output
_PLUGIN_MAX_LINES = 5000         # ...and the total number of lines streamed


def _plugin_dir(pid: str) -> str:
    """Resolve a plugin id to its folder, confined to PLUGINS_DIR."""
    if not _PLUGIN_ID_RE.match(pid or ""):
        raise ValueError("bad plugin id")
    path = os.path.realpath(os.path.join(PLUGINS_DIR, pid))
    root = os.path.realpath(PLUGINS_DIR)
    if os.path.commonpath([path, root]) != root or not os.path.isdir(path):
        raise ValueError("no such plugin")
    return path


def _plugin_file_path(pid: str, name: str, must_exist: bool = False) -> str:
    """Resolve one file inside a plugin's folder -- confined + basename-only so a
    crafted name can't escape plugins/<id>/ (mirrors _plugin_dir's confinement)."""
    base = _plugin_dir(pid)                         # validates id + confinement
    fname = os.path.basename((name or "").strip())
    if not fname or fname.startswith("."):
        raise ValueError("bad file name")
    path = os.path.realpath(os.path.join(base, fname))
    if os.path.commonpath([path, os.path.realpath(base)]) != os.path.realpath(base):
        raise ValueError("bad file name")
    if must_exist and not os.path.isfile(path):
        raise ValueError("no such file")
    return path


def _plugin_venv_python(path: str) -> Optional[str]:
    """The per-plugin venv interpreter, if the plugin has been set up. Deps
    install into an isolated ./.venv so a tool's packages never collide with
    AEYE's own environment (or another plugin's)."""
    for rel in ("Scripts/python.exe", "bin/python", "bin/python3"):
        exe = os.path.join(path, ".venv", *rel.split("/"))
        if os.path.isfile(exe):
            return exe
    return None


def _plugin_reqfile(path: str, manifest: dict) -> str:
    """The requirements filename to install, if present (manifest override or
    a conventional requirements.txt). Empty string = nothing to install."""
    name = str(manifest.get("requirements") or "requirements.txt")
    name = os.path.basename(name)               # no path escapes
    return name if os.path.isfile(os.path.join(path, name)) else ""


def _plugin_load(pid: str, path: str) -> dict:
    """Read + validate one manifest. Returns a dict with an `error` key set
    instead of raising, so one broken plugin never hides the rest."""
    base = {"id": pid, "name": pid, "trigger": "", "description": "",
            "command": [], "cwd": ".", "timeout": 120, "error": None,
            "requirements": "", "installed": False, "mode": "stream",
            # agentic-tool fields (all optional -- absent => a normal trigger plugin)
            "type": "command", "access": "exec", "args": []}
    try:
        with open(os.path.join(path, "aeye-plugin.json"), encoding="utf-8") as f:
            m = json.load(f)
    except FileNotFoundError:
        base["error"] = "no aeye-plugin.json"
        return base
    except Exception as e:
        base["error"] = f"bad manifest: {e}"
        return base
    cmd = m.get("command")
    if not isinstance(cmd, list) or not cmd or not all(isinstance(x, str) for x in cmd):
        base["error"] = "manifest 'command' must be a non-empty list of strings"
    ptype = str(m.get("type") or "command").lower()
    if ptype not in ("command", "tool"):
        ptype = "command"
    trig = (m.get("trigger") or "").strip()
    # a trigger is required for command plugins (how the user invokes them); for
    # a tool plugin it doubles as the LLM-facing tool name and is still required.
    if not trig:
        base["error"] = base["error"] or "manifest 'trigger' is required"
    mode = str(m.get("mode") or "stream").lower()
    if mode not in ("stream", "terminal", "interactive"):
        mode = "stream"
    access = str(m.get("access") or "exec").lower()
    if access not in ("read", "write", "exec"):
        access = "exec"
    # args: [{name, type, description, required}] -- sanitised, tool plugins only
    args = []
    raw_args = m.get("args")
    if isinstance(raw_args, list):
        for a in raw_args[:12]:
            if not isinstance(a, dict):
                continue
            an = str(a.get("name") or "").strip()
            if not an or not re.match(r"^[A-Za-z_][A-Za-z0-9_]{0,39}$", an):
                continue
            atype = str(a.get("type") or "string").lower()
            if atype not in ("string", "path", "number", "boolean"):
                atype = "string"
            args.append({"name": an, "type": atype,
                         "description": str(a.get("description") or "")[:200],
                         "required": bool(a.get("required", True))})
    base.update(name=str(m.get("name") or pid)[:80], trigger=trig[:60],
                description=str(m.get("description") or "")[:300],
                command=cmd if isinstance(cmd, list) else [],
                cwd=str(m.get("cwd") or "."),
                timeout=max(1, min(int(m.get("timeout") or 120), 1800)),
                requirements=_plugin_reqfile(path, m),
                installed=_plugin_venv_python(path) is not None,
                mode=mode, type=ptype, access=access, args=args)
    return base


def _plugin_prepare(pid: str, query: str):
    """Resolve + validate a plugin and build its argv: `{query}` substituted
    into each item (stays ONE arg -- no shell, no injection), the per-plugin
    venv python swapped in for `python`/`python3` when present, and cwd
    resolved + confined to ./plugins. Raises ValueError on any problem.
    Shared by run / launch (terminal) / interactive."""
    path = _plugin_dir(pid)                         # raises ValueError
    man = _plugin_load(pid, path)
    if man["error"]:
        raise ValueError(man["error"])
    argv = [part.replace("{query}", query or "") for part in man["command"]]
    if argv and argv[0] in ("python", "python3"):
        vpy = _plugin_venv_python(path)
        if vpy:
            argv[0] = vpy
    cwd = os.path.realpath(os.path.join(path, man["cwd"]))
    if os.path.commonpath([cwd, os.path.realpath(PLUGINS_DIR)]) \
            != os.path.realpath(PLUGINS_DIR):
        raise ValueError("plugin cwd escapes the plugins folder")
    return man, argv, cwd


def _plugins_all() -> list:
    out = []
    try:
        names = sorted(os.listdir(PLUGINS_DIR))
    except OSError:
        return out
    for name in names:
        full = os.path.join(PLUGINS_DIR, name)
        if os.path.isdir(full) and _PLUGIN_ID_RE.match(name):
            out.append(_plugin_load(name, full))
    return out


class PluginRunReq(BaseModel):
    id: str
    query: str = ""


@app.get("/api/plugins/list")
def plugins_list():
    return {"plugins": _plugins_all(), "dir": PLUGINS_DIR}


@app.post("/api/plugins/run")
def plugins_run(req: PluginRunReq):
    """Run one plugin's declared command, streaming stdout+stderr as SSE
    lines. The user's query is substituted into argv items (never a shell)."""
    def gen():
        try:
            man, argv, cwd = _plugin_prepare(req.id, req.query)
        except ValueError as e:
            yield _sse({"error": str(e)})
            return
        yield _sse({"status": "$ " + " ".join(argv)})
        try:
            proc = subprocess.Popen(
                argv, cwd=cwd, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                errors="replace", creationflags=NOWIN)
        except FileNotFoundError:
            yield _sse({"error": f"command not found: {argv[0]!r} "
                        "(is it installed / on PATH?)"})
            return
        except Exception as e:
            yield _sse({"error": f"{type(e).__name__}: {e}"})
            return
        deadline = time.time() + man["timeout"]
        lines = 0
        try:
            for line in proc.stdout:
                if time.time() > deadline:
                    proc.kill()
                    yield _sse({"error": f"timed out after {man['timeout']}s"})
                    return
                yield _sse({"line": line.rstrip("\n")[:_PLUGIN_MAX_LINE]})
                lines += 1
                if lines >= _PLUGIN_MAX_LINES:
                    proc.kill()
                    yield _sse({"error": f"output truncated at {lines} lines"})
                    return
            code = proc.wait()
            yield _sse({"done": True, "code": code})
        except Exception as e:
            try:
                proc.kill()
            except Exception:
                pass
            yield _sse({"error": f"{type(e).__name__}: {e}"})
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ==========================================================================
# Agentic tools: let the LLM CALL plugins (and a few safe built-ins) as tools.
#
# This is ADDITIVE to the trigger system -- trigger plugins are untouched. A
# plugin opts in with "type":"tool" in its manifest; the model emits a tool call
# (detected frontend-side, mirroring the web-tool loop), and the frontend posts
# it here to run. All the real guardrails live server-side so a crafted request
# can't exceed them:
#   * master switch (disabled by default -- AEYE stays purely interactive)
#   * a permission MODE gates what may run: read < write < autonomous(exec)
#   * every path argument is confined to a user-chosen ROOT dir (no escape)
#   * built-in read_file/list_dir/write_file work out of the box; custom tools
#     reuse the EXISTING plugin execution path (Python + Node, per-plugin venv).
# --------------------------------------------------------------------------
_AGENT_CFG_FILE = os.path.join(paths.DATA_DIR, "agent_tools.json")
_agent_lock = threading.Lock()
_TOOL_OUT_MAX = 16000            # cap tool output chars (truncate beyond this)
_MODE_RANK = {"read": 0, "write": 1, "auto": 2}
_ACCESS_RANK = {"read": 0, "write": 1, "exec": 2}
# environment/dependency error signatures -- classified so the loop can stop early
_ENV_ERR_RE = re.compile(
    r"ModuleNotFoundError|ImportError|No module named|cannot import name|"
    r"DLL load failed|AttributeError", re.I)


def _truncate(s) -> str:
    s = "" if s is None else str(s)
    return s if len(s) <= _TOOL_OUT_MAX else s[:_TOOL_OUT_MAX] + "\n[TRUNCATED]"


def _ok(output, meta=None) -> dict:
    """Structured success per the tool output contract (optional meta block)."""
    r = {"success": True, "output": _truncate(output), "error": None}
    if meta is not None:
        r["meta"] = meta
    return r


def _file_hash(fp: str):
    """SHA-256 of a file's bytes, or None if it can't be read."""
    try:
        import hashlib
        h = hashlib.sha256()
        with open(fp, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def _err(msg) -> dict:
    """Structured failure -- a single clean line, never a stack trace."""
    return {"success": False, "output": None, "error": str(msg)[:400]}


def _sanitize_err(text: str):
    """Collapse raw stderr/exception text to one clean line (no full traceback to
    the model). Returns the message string."""
    t = (text or "").strip()
    lines = [ln for ln in t.splitlines() if ln.strip()]
    # prefer the last line that looks like 'ExceptionType: message'
    for ln in reversed(lines):
        if re.match(r"^\w+(Error|Exception|Warning)\b", ln.strip()):
            return ln.strip()[:400]
    return (lines[-1].strip() if lines else "tool failed")[:400]


def _agent_default_root() -> str:
    docs = os.path.join(os.path.expanduser("~"), "Documents")
    base = docs if os.path.isdir(docs) else os.path.expanduser("~")
    return os.path.join(base, "AEYE-Agent")


_agent_cfg = {"enabled": False, "mode": "read", "approval": "auto",
              "root": _agent_default_root(), "debug": False, "dry_run": False,
              "force_agent": False}   # A/B: force full-plan AGENT path (never weakens safety)


def _tool_log(kind: str, **kw) -> None:
    """Dev-only tool lifecycle log ([TOOL CALL] / [TOOL RESULT]); silent unless
    debug is enabled. Never prints args/output contents -- just names + status."""
    if not _agent_cfg.get("debug"):
        return
    try:
        print("AEYE {} {}".format(kind, " ".join(
            "{}={}".format(k, v) for k, v in kw.items())), flush=True)
    except Exception:
        pass


def _agent_cfg_load():
    try:
        with open(_AGENT_CFG_FILE, encoding="utf-8") as f:
            d = json.load(f)
        for k in ("enabled", "mode", "approval", "root", "debug", "dry_run", "force_agent"):
            if k in d:
                _agent_cfg[k] = d[k]
    except Exception:
        pass


def _agent_cfg_save():
    try:
        with open(_AGENT_CFG_FILE, "w", encoding="utf-8") as f:
            json.dump(_agent_cfg, f)
    except Exception:
        pass


_agent_cfg_load()


def _agent_root() -> str:
    root = os.path.realpath(_agent_cfg.get("root") or _agent_default_root())
    try:
        os.makedirs(root, exist_ok=True)
    except OSError:
        pass
    return root


# Phase 1 -- startup readiness: prepare the saved root now so tool access is
# ready without a manual button press. Never silently switches to another folder;
# an invalid root simply leaves tools blocked (see root_valid in the config).
try:
    if _agent_cfg.get("root"):
        _root0 = _agent_root()
        if _agent_cfg.get("debug"):
            print("AEYE [AGENT STARTUP] enabled={} mode={} root={} valid={}".format(
                _agent_cfg.get("enabled"), _agent_cfg.get("mode"), _root0,
                os.path.isdir(_root0)), flush=True)
except Exception:
    pass


def _confine(p: str) -> str:
    """Resolve a (relative or absolute) path against the allowed root and REJECT
    anything that escapes it. Returns the safe absolute path."""
    root = _agent_root()
    raw = (p or "").strip()
    full = os.path.realpath(raw if os.path.isabs(raw) else os.path.join(root, raw))
    if os.path.commonpath([full, root]) != root:
        raise ValueError("path '{}' is outside the allowed root".format(p))
    return full


def _mode_allows(access: str) -> bool:
    mode = _agent_cfg.get("mode", "read")
    return _ACCESS_RANK.get(access, 2) <= _MODE_RANK.get(mode, 0)


# ---- built-in file tools (confined to the root; structured contract) -------
_BUILTIN_TOOLS = [
    {"name": "list_files", "access": "read", "source": "builtin",
     "description": "List files and folders inside a directory in the workspace.",
     "args": [{"name": "path", "type": "path", "required": False,
               "description": "Directory relative to the workspace root (default: root)."}]},
    {"name": "read_file", "access": "read", "source": "builtin",
     "description": "Read and return the text contents of a file in the workspace.",
     "args": [{"name": "path", "type": "path", "required": True,
               "description": "File to read, relative to the workspace root."}]},
    {"name": "preview_diff", "access": "read", "source": "builtin",
     "description": "Preview a unified diff between a file's current contents and proposed new content. REQUIRED before overwriting an existing file. Returns meta with the file hash.",
     "args": [{"name": "path", "type": "path", "required": True,
               "description": "File to preview changes for, relative to the workspace root."},
              {"name": "new_content", "type": "string", "required": True,
               "description": "The proposed new full contents of the file."}]},
    {"name": "check_code", "access": "read", "source": "builtin",
     "description": "Validate the SYNTAX of a code file without running it (Python via ast, JS via node --check).",
     "args": [{"name": "path", "type": "path", "required": True,
               "description": "Code file to syntax-check, relative to the workspace root."}]},
    {"name": "write_file", "access": "write", "source": "builtin",
     "description": "Create or overwrite a text file. To OVERWRITE an existing file you MUST call preview_diff for that path first (its hash must still match); creating a new file needs no diff.",
     "args": [{"name": "path", "type": "path", "required": True,
               "description": "File to write, relative to the workspace root."},
              {"name": "content", "type": "string", "required": True,
               "description": "The full text to write into the file."}]},
    {"name": "move_file", "access": "write", "source": "builtin",
     "description": "Move or rename a file within the workspace. Source must exist; destination must not overwrite an existing file.",
     "args": [{"name": "path_from", "type": "path", "required": True,
               "description": "Existing file to move, relative to the workspace root."},
              {"name": "path_to", "type": "path", "required": True,
               "description": "Destination path, relative to the workspace root."}]},
    {"name": "create_directory", "access": "write", "source": "builtin",
     "description": "Create a directory in the workspace (will not overwrite an existing file).",
     "args": [{"name": "path", "type": "path", "required": True,
               "description": "Directory to create, relative to the workspace root."}]},
    {"name": "delete_file", "access": "write", "source": "builtin",
     "description": "Delete a single file in the workspace. STRICTLY GUARDED: must be its own explicit plan step.",
     "args": [{"name": "path", "type": "path", "required": True,
               "description": "File to delete, relative to the workspace root."}]},
    {"name": "run_command", "access": "exec", "source": "builtin",
     "description": "Run ONLY `python <script>` or `node <script>` inside the workspace (no shell chaining, 10s timeout).",
     "args": [{"name": "cmd", "type": "string", "required": True,
               "description": "e.g. 'python script.py' or 'node app.js' -- script must be in the workspace."}]},
    {"name": "pip_install", "access": "exec", "source": "builtin",
     "description": "Install a Python package into the workspace's ISOLATED .venv only (never system Python).",
     "args": [{"name": "package", "type": "string", "required": True,
               "description": "Package name, optionally pinned (e.g. requests==2.31.0)."}]},
]

# diff-gate: an overwrite of an EXISTING file is only allowed after preview_diff
# for that exact resolved path AND the file hash must still match. preview_diff
# records (timestamp, hash) here; write_file verifies + consumes it.
_DIFF_TTL = 600.0                     # a preview is valid for 10 min
_diff_ok = {}                         # resolved_path -> (timestamp, hash_at_preview)
_PKG_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,60}(\[[A-Za-z0-9,._-]+\])?"
                     r"(==[A-Za-z0-9._-]+)?$")


def _dry() -> bool:
    return bool(_agent_cfg.get("dry_run"))


def _venv_python() -> str:
    """The workspace .venv interpreter path (may not exist yet)."""
    root = _agent_root()
    for rel in ("Scripts/python.exe", "bin/python", "bin/python3"):
        p = os.path.join(root, ".venv", *rel.split("/"))
        if os.path.isfile(p):
            return p
    return ""


def _builtin_run(name: str, args: dict) -> dict:
    """Run a built-in tool. Paths go through _confine (safe_path). Always returns
    the {success, output, error} contract. Mutating tools honour dry_run."""
    dry = _dry()
    if name == "list_files":
        d = _confine(args.get("path") or ".")
        if not os.path.isdir(d):
            return _err("not a directory: {}".format(args.get("path") or "."))
        rows = []
        for e in sorted(os.listdir(d))[:1000]:
            fp = os.path.join(d, e)
            rows.append(("[dir]  " if os.path.isdir(fp) else "       ") + e)
        rel = os.path.relpath(d, _agent_root())
        return _ok("Contents of {}:\n{}".format(
            rel if rel != "." else "(workspace root)", "\n".join(rows) or "(empty)"))

    if name == "read_file":
        fp = _confine(args["path"])
        if not os.path.isfile(fp):
            return _err("no such file: {}".format(args["path"]))
        with open(fp, "rb") as f:
            data = f.read(_TOOL_OUT_MAX * 4 + 1)
        return _ok(data.decode("utf-8", "replace"))

    if name == "preview_diff":
        import difflib
        fp = _confine(args["path"])
        rel = os.path.relpath(fp, _agent_root())
        new_text = str(args.get("new_content", ""))
        exists = os.path.isfile(fp)
        fhash = _file_hash(fp) if exists else None
        # record (time, hash) so a matching write_file may overwrite (dry_run too)
        _diff_ok[fp] = (time.time(), fhash)
        meta = {"path": rel, "exists": exists, "hash": fhash}
        if not exists:
            return _ok("[new file: {}] no existing content -- write_file will create it "
                       "({} bytes).".format(rel, len(new_text)), meta=meta)
        with open(fp, "r", encoding="utf-8", errors="replace") as f:
            old_text = f.read()
        if old_text == new_text:
            return _ok("[no changes] proposed content is identical to {}.".format(rel), meta=meta)
        diff = difflib.unified_diff(
            old_text.splitlines(), new_text.splitlines(),
            fromfile="a/" + rel, tofile="b/" + rel, lineterm="")
        return _ok("\n".join(diff), meta=meta)

    if name == "check_code":
        fp = _confine(args["path"])
        if not os.path.isfile(fp):
            return _err("no such file: {}".format(args["path"]))
        ext = os.path.splitext(fp)[1].lower()
        if ext == ".py":
            import ast
            try:
                with open(fp, "r", encoding="utf-8", errors="replace") as f:
                    ast.parse(f.read())
                return _ok("OK: {} is valid Python syntax.".format(args["path"]))
            except SyntaxError as e:
                return {"success": False, "output": None,
                        "error": "syntax error: line {}: {}".format(e.lineno, e.msg)}
        if ext in (".js", ".mjs", ".cjs"):
            try:
                proc = subprocess.run(["node", "--check", fp], capture_output=True,
                                      text=True, timeout=10, creationflags=NOWIN)
                if proc.returncode == 0:
                    return _ok("OK: {} is valid JavaScript syntax.".format(args["path"]))
                return {"success": False, "output": None,
                        "error": "syntax error: " + _sanitize_err(proc.stderr)}
            except FileNotFoundError:
                return _err("node is not installed -- cannot syntax-check JavaScript")
            except subprocess.TimeoutExpired:
                return _err("syntax check timed out")
        return _err("no syntax validator for '{}' files".format(ext or "?"))

    if name == "write_file":
        fp = _confine(args["path"])
        content = str(args.get("content", ""))
        if os.path.isfile(fp):
            rec = _diff_ok.get(fp)
            if not rec or (time.time() - rec[0]) > _DIFF_TTL:
                return _err("preview_diff required before overwriting an existing file. "
                            "Call preview_diff with the same path first, then write_file.")
            if rec[1] != _file_hash(fp):
                _diff_ok.pop(fp, None)
                return _err("File changed since preview. Re-run preview_diff.")
            if not dry:
                _diff_ok.pop(fp, None)           # consume only on a real write
        if dry:
            return _ok("[dry-run] would write {} bytes to {}".format(
                len(content), os.path.relpath(fp, _agent_root())))
        os.makedirs(os.path.dirname(fp) or _agent_root(), exist_ok=True)
        with open(fp, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return _ok("Wrote {} bytes to {}".format(
            len(content), os.path.relpath(fp, _agent_root())))

    if name == "move_file":
        src = _confine(args["path_from"])
        dst = _confine(args["path_to"])
        if not os.path.isfile(src):
            return _err("source file does not exist: {}".format(args["path_from"]))
        if os.path.exists(dst):
            return _err("destination already exists: {}".format(args["path_to"]))
        if dry:
            return _ok("[dry-run] would move {} -> {}".format(args["path_from"], args["path_to"]))
        os.makedirs(os.path.dirname(dst) or _agent_root(), exist_ok=True)
        os.replace(src, dst)
        return _ok("Moved {} -> {}".format(args["path_from"], args["path_to"]))

    if name == "create_directory":
        d = _confine(args["path"])
        if os.path.isfile(d):
            return _err("a file already exists at that path: {}".format(args["path"]))
        if dry:
            return _ok("[dry-run] would create directory {}".format(args["path"]))
        os.makedirs(d, exist_ok=True)
        return _ok("Created directory {}".format(args["path"]))

    if name == "delete_file":
        fp = _confine(args["path"])
        if not os.path.isfile(fp):
            return _err("no such file: {}".format(args["path"]))
        if dry:
            return _ok("[dry-run] would delete {}".format(args["path"]))
        os.remove(fp)
        return _ok("Deleted {}".format(args["path"]))

    if name == "run_command":
        return _run_command(str(args.get("cmd", "")), dry)

    if name == "pip_install":
        return _pip_install(str(args.get("package", "")), dry)

    return _err("unknown built-in tool")


def _run_command(cmd: str, dry: bool) -> dict:
    """ALLOWLIST-only runner: `python <script>` or `node <script>` inside the
    sandbox root. No shell, no chaining, 10s cap, sanitized output."""
    cmd = (cmd or "").strip()
    if any(ch in cmd for ch in ("&", "|", ";", ">", "<", "`", "$", "\n", "\r")):
        return _err("command chaining/redirection is not allowed")
    parts = cmd.split()
    if len(parts) < 2:
        return _err("only 'python <script>' or 'node <script>' are allowed")
    runner = parts[0].lower()
    if runner not in ("python", "python3", "node"):
        return _err("only python or node scripts may be run")
    try:
        script = _confine(parts[1])               # script must live in the sandbox
    except ValueError as e:
        return _err(str(e))
    if not os.path.isfile(script):
        return _err("script not found in workspace: {}".format(parts[1]))
    exe = runner
    if runner in ("python", "python3"):
        exe = _venv_python() or ("python" if os.name == "nt" else "python3")
    argv = [exe, script] + parts[2:]
    if dry:
        return _ok("[dry-run] would run: {} {}".format(runner, " ".join(parts[1:])))
    try:
        env = dict(os.environ)                    # copy -- never mutate the real env
        proc = subprocess.run(argv, cwd=_agent_root(), capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=10,
                              env=env, creationflags=NOWIN)
        out = proc.stdout or ""
        if proc.returncode != 0:
            return {"success": False, "output": _truncate(out) if out else None,
                    "error": _sanitize_err(proc.stderr or "exited with code {}".format(proc.returncode))}
        return _ok(out or "(no output)")
    except subprocess.TimeoutExpired:
        return _err("command timed out (10s limit)")
    except FileNotFoundError:
        return _err("{} runtime not found".format(runner))
    except Exception as e:
        return _err(type(e).__name__)


def _pip_install(package: str, dry: bool) -> dict:
    """Install a package into the workspace's ISOLATED .venv only. Never touches
    system Python or PATH."""
    package = (package or "").strip()
    if not _PKG_RE.match(package):
        return _err("invalid package name")
    root = _agent_root()
    vpy = _venv_python()
    if dry:
        return _ok("[dry-run] would install '{}' into {}/.venv".format(package, os.path.basename(root)))
    if not vpy:
        # bootstrap an isolated venv with a base interpreter from PATH (this is a
        # real python.exe, never the frozen AEYE.exe, so it's safe to use)
        base = shutil.which("python") or shutil.which("python3")
        if not base:
            return _err("no base Python available to create the workspace .venv")
        try:
            subprocess.run([base, "-m", "venv", os.path.join(root, ".venv")],
                           capture_output=True, text=True, timeout=120, creationflags=NOWIN)
        except Exception:
            return _err("could not create the workspace .venv")
        vpy = _venv_python()
        if not vpy:
            return _err("could not create the workspace .venv")
    try:
        proc = subprocess.run([vpy, "-m", "pip", "install", package],
                              capture_output=True, text=True, encoding="utf-8",
                              errors="replace", timeout=180, creationflags=NOWIN)
        if proc.returncode != 0:
            return {"success": False, "output": None,
                    "error": _sanitize_err(proc.stderr or proc.stdout or "pip failed")}
        return _ok("Installed '{}' into the workspace .venv.".format(package))
    except subprocess.TimeoutExpired:
        return _err("pip install timed out")
    except Exception as e:
        return _err(type(e).__name__)


def _tool_registry() -> list:
    """All LLM-callable tools = built-ins + every plugin declaring type:tool."""
    tools = [dict(t) for t in _BUILTIN_TOOLS]
    for p in _plugins_all():
        if p.get("type") == "tool" and not p.get("error") and p.get("trigger"):
            tools.append({"name": p["trigger"], "access": p.get("access", "exec"),
                          "source": "plugin", "id": p["id"],
                          "description": p.get("description", ""),
                          "args": p.get("args", [])})
    return tools


def _tool_by_name(name: str):
    for t in _tool_registry():
        if t["name"] == name:
            return t
    return None


def _validate_args(tool: dict, args: dict):
    """Schema check BEFORE execution: required present + non-empty, correct type.
    Returns (clean_args, error_message_or_None). Path args stay strings here;
    confinement (safe_path) happens at execution."""
    clean = {}
    for spec in tool.get("args", []):
        an = spec["name"]
        atype = spec.get("type", "string")
        req = spec.get("required", True)
        v = args.get(an)
        empty = v is None or (isinstance(v, str) and v.strip() == "")
        if empty:
            if req:
                return None, "missing or empty required argument '{}'".format(an)
            continue
        if atype == "number":
            try:
                v = float(v)
            except (TypeError, ValueError):
                return None, "argument '{}' must be a number".format(an)
        elif atype == "boolean":
            v = bool(v)
        else:
            v = str(v)
        clean[an] = v
    return clean, None


def _run_plugin_tool(tool: dict, args: dict) -> dict:
    """Execute a type:tool plugin: named {arg} substitution into its argv (path
    args pre-confined to the root), no shell, bounded output + timeout. Returns
    the {success, output, error} contract; a plugin that already prints that
    contract on stdout is passed through, otherwise its stdout is wrapped and any
    stderr traceback is collapsed to one clean line (never leaked in full)."""
    try:
        path = _plugin_dir(tool["id"])
        man = _plugin_load(tool["id"], path)
        if man["error"]:
            return _err(man["error"])
        vals = {}
        for spec in man.get("args", []):
            an = spec["name"]
            if an not in args:
                continue
            v = args[an]
            if spec["type"] == "path":
                v = _confine(str(v))          # absolute, confined -> safe for the tool
            vals[an] = str(v)
        argv = []
        for part in man["command"]:
            for an, v in vals.items():
                part = part.replace("{" + an + "}", v)
            argv.append(part)
        if argv and argv[0] in ("python", "python3"):
            vpy = _plugin_venv_python(path)
            if vpy:
                argv[0] = vpy
        cwd = os.path.realpath(os.path.join(path, man["cwd"]))
        if os.path.commonpath([cwd, os.path.realpath(PLUGINS_DIR)]) != os.path.realpath(PLUGINS_DIR):
            return _err("plugin cwd escapes the plugins folder")
        proc = subprocess.run(argv, cwd=cwd, capture_output=True, text=True,
                              encoding="utf-8", errors="replace",
                              timeout=man["timeout"], creationflags=NOWIN)
        stdout, stderr = proc.stdout or "", proc.stderr or ""
        # pass through a tool that already speaks the contract
        st = stdout.strip()
        if st.startswith("{"):
            try:
                j = json.loads(st)
                if isinstance(j, dict) and "success" in j:
                    if j.get("success"):
                        return _ok(j.get("output") or "")
                    return _err(j.get("error") or "tool reported failure")
            except Exception:
                pass
        if proc.returncode != 0 or (stderr and not stdout.strip()):
            return _err(_sanitize_err(stderr or stdout))
        return _ok(stdout)
    except subprocess.TimeoutExpired:
        return _err("tool timed out")
    except FileNotFoundError:
        return _err("tool command not found (is the runtime installed?)")
    except ValueError as e:                       # path confinement / access denied
        return _err(str(e))
    except Exception as e:
        return _err(type(e).__name__)


class AgentCfgReq(BaseModel):
    enabled: Optional[bool] = None
    mode: Optional[str] = None            # "read" | "write" | "auto"
    approval: Optional[str] = None        # "auto" | "confirm"
    root: Optional[str] = None
    debug: Optional[bool] = None          # dev-only tool lifecycle logging
    dry_run: Optional[bool] = None        # simulate mutations (no filesystem writes)
    force_agent: Optional[bool] = None    # A/B: always take the full-plan AGENT path


class ToolRunReq(BaseModel):
    name: str
    args: dict = {}


def _root_valid() -> bool:
    """Is the configured workspace root a real, accessible directory?"""
    try:
        return os.path.isdir(_agent_root())
    except Exception:
        return False


def _cfg_view() -> dict:
    """Config + resolved/validated root -- so the UI shows a clear ready/blocked
    state without a button click (Phase 1: startup readiness)."""
    return {"ok": True, "config": dict(_agent_cfg),
            "root_resolved": _agent_root(), "root_valid": _root_valid()}


@app.get("/api/plugins/tool/config")
def agent_tool_config_get():
    return _cfg_view()


@app.post("/api/plugins/tool/config")
def agent_tool_config_set(req: AgentCfgReq):
    with _agent_lock:
        if req.enabled is not None:
            _agent_cfg["enabled"] = bool(req.enabled)
        if req.mode in ("read", "write", "auto"):
            _agent_cfg["mode"] = req.mode
        if req.approval in ("auto", "confirm"):
            _agent_cfg["approval"] = req.approval
        if req.root is not None and str(req.root).strip():
            newroot = str(req.root).strip()
            if newroot != _agent_cfg.get("root"):
                _diff_ok.clear()          # Phase 15: stale diff/hash state must not survive a root change
            _agent_cfg["root"] = newroot
        if req.debug is not None:
            _agent_cfg["debug"] = bool(req.debug)
        if req.dry_run is not None:
            _agent_cfg["dry_run"] = bool(req.dry_run)
        if req.force_agent is not None:
            _agent_cfg["force_agent"] = bool(req.force_agent)
        _agent_cfg_save()
    return _cfg_view()


@app.get("/api/plugins/tools")
def agent_tools_list():
    """Tools available to the LLM, plus current config. `allowed` reflects the
    active mode so the frontend only advertises what can actually run."""
    reg = _tool_registry()
    for t in reg:
        t["allowed"] = _mode_allows(t.get("access", "exec"))
    v = _cfg_view()
    v["tools"] = reg
    return v


@app.post("/api/plugins/tool/run")
def agent_tool_run(req: ToolRunReq):
    """SAFE TOOL EXECUTION LAYER. Before running ANYTHING, validate in order:
    master switch -> tool exists -> permission mode -> argument schema. Any failure
    returns the {success, output, error} contract and does NOT execute. Path args
    are confined to the root inside the tool. Never raises / leaks a stack trace."""
    name = (req.name or "").strip()
    _tool_log("[TOOL CALL]", tool=name or "?")
    if not _agent_cfg.get("enabled"):
        return _err("LLM tool access is disabled")
    tool = _tool_by_name(name)
    if not tool:                                  # validate tool exists
        _tool_log("[TOOL RESULT]", tool=name, status="unknown_tool")
        return _err("unknown tool '{}'".format(name))
    if not _mode_allows(tool.get("access", "exec")):   # validate permission mode
        _tool_log("[TOOL RESULT]", tool=name, status="denied_mode")
        return _err("'{}' is not allowed in {} mode".format(name, _agent_cfg.get("mode")))
    raw = req.args if isinstance(req.args, dict) else {}
    clean, verr = _validate_args(tool, raw)       # validate + sanitize args
    if verr:
        _tool_log("[TOOL RESULT]", tool=name, status="invalid_args")
        return _err(verr)
    try:
        if tool["source"] == "builtin":
            res = _builtin_run(tool["name"], clean)
        else:
            res = _run_plugin_tool(tool, clean)
    except ValueError as e:                        # path-confinement / access denied
        res = _err(str(e))
    except Exception as e:                          # never crash / leak a traceback
        res = _err(type(e).__name__)
    _tool_log("[TOOL RESULT]", tool=name,
              status="ok" if res.get("success") else "error")
    return res


@app.post("/api/plugins/install")
def plugins_install(req: PluginRunReq):
    """Set up a plugin's dependencies: create an ISOLATED per-plugin venv
    (./.venv inside the plugin folder) and `pip install -r requirements.txt`
    into it, streaming pip's output. Isolation is deliberate -- a tool's
    packages must never upgrade/collide with AEYE's own env. The runner then
    uses this venv automatically. Button-triggered only; installing runs the
    package's own build hooks, same trust as running the tool itself."""
    def gen():
        try:
            path = _plugin_dir(req.id)
        except ValueError as e:
            yield _sse({"error": str(e)})
            return
        man = _plugin_load(req.id, path)
        reqfile = man.get("requirements")
        if not reqfile:
            yield _sse({"error": "no requirements.txt in this plugin "
                        "(nothing to install)"})
            return
        venv_dir = os.path.join(path, ".venv")
        vpy = _plugin_venv_python(path)
        # 1. create the isolated env once (reused on re-install)
        if not vpy:
            yield _sse({"status": "creating isolated environment (.venv)…"})
            try:
                r = subprocess.run([sys.executable, "-m", "venv", venv_dir],
                                   capture_output=True, text=True,
                                   encoding="utf-8", errors="replace",
                                   creationflags=NOWIN, timeout=180)
            except Exception as e:
                yield _sse({"error": f"venv creation failed: {e}"})
                return
            if r.returncode != 0:
                yield _sse({"error": "venv creation failed: "
                            + (r.stderr or r.stdout or "")[:300]})
                return
            vpy = _plugin_venv_python(path)
        if not vpy:
            yield _sse({"error": "could not locate the venv python"})
            return
        # 2. pip install -r <reqfile> into that venv, streamed live
        argv = [vpy, "-m", "pip", "install", "-r",
                os.path.join(path, reqfile)]
        yield _sse({"status": "$ " + " ".join(argv)})
        try:
            proc = subprocess.Popen(
                argv, cwd=path, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                errors="replace", creationflags=NOWIN)
        except Exception as e:
            yield _sse({"error": f"{type(e).__name__}: {e}"})
            return
        deadline = time.time() + 1800          # pip can be slow (big wheels)
        lines = 0
        try:
            for line in proc.stdout:
                if time.time() > deadline:
                    proc.kill()
                    yield _sse({"error": "install timed out after 30 min"})
                    return
                yield _sse({"line": line.rstrip("\n")[:_PLUGIN_MAX_LINE]})
                lines += 1
                if lines >= _PLUGIN_MAX_LINES:
                    proc.kill()
                    yield _sse({"error": f"output truncated at {lines} lines"})
                    return
            code = proc.wait()
            yield _sse({"done": True, "code": code})
        except Exception as e:
            try:
                proc.kill()
            except Exception:
                pass
            yield _sse({"error": f"{type(e).__name__}: {e}"})
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@app.post("/api/plugins/launch")
def plugins_launch(req: PluginRunReq):
    """`mode: terminal` -- launch the tool in its OWN real console window
    (CREATE_NEW_CONSOLE) so it gets a genuine terminal: menus, TUIs, prompts
    all work natively. Fire-and-forget -- output stays in that window, not
    chat. AEYE is just the launcher. Windows only."""
    try:
        man, argv, cwd = _plugin_prepare(req.id, req.query)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    if os.name != "nt":
        return {"ok": False, "error": "terminal mode is Windows-only"}
    try:
        # its own console; no pipes (inherits the new console's tty), detached
        subprocess.Popen(argv, cwd=cwd, creationflags=NEWCONSOLE, close_fds=True)
    except FileNotFoundError:
        return {"ok": False, "error": f"command not found: {argv[0]!r}"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    return {"ok": True, "command": " ".join(argv)}


# ---- interactive sessions (`mode: interactive`) --------------------------
# A long-lived process whose stdout streams into a chat bubble and whose
# stdin is fed by your chat messages -- a prompt/answer session in the
# conversation. Line-oriented (readline-style tools); a full-screen TUI
# still needs `mode: terminal`. stdout is read as raw bytes so a prompt with
# no trailing newline still surfaces; PYTHONUNBUFFERED nudges Python tools to
# flush. The session dies when the process exits, on /stop, or when the SSE
# output stream closes (tab/chat gone).

_PLUGIN_SESSIONS: dict = {}
_PLUGIN_SESS_LOCK = threading.Lock()
_PLUGIN_SESS_MAX = 4
_PLUGIN_SESS_TTL = 3600          # hard lifetime cap (s), anti-zombie


class _PlugSession:
    def __init__(self, sid: str, proc, man: dict):
        self.sid = sid
        self.proc = proc
        self.man = man
        self.q: queue.Queue = queue.Queue()
        self.started = time.time()
        self.alive = True
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

    def _pump(self):
        dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
        try:
            while True:
                chunk = self.proc.stdout.read(4096)   # bytes; as they arrive
                if not chunk:
                    break
                self.q.put(dec.decode(chunk))
        except Exception:
            pass
        finally:
            tail = dec.decode(b"", final=True)
            if tail:
                self.q.put(tail)
            self.alive = False
            self.q.put(None)              # EOF sentinel

    def send(self, text: str):
        self.proc.stdin.write((text + "\n").encode("utf-8"))
        self.proc.stdin.flush()

    def stop(self):
        self.alive = False
        for f in (self.proc.stdin, self.proc.stdout):
            try:
                f.close()
            except Exception:
                pass
        try:
            self.proc.kill()
        except Exception:
            pass


class PlugSessionReq(BaseModel):
    session: str


class PlugInputReq(BaseModel):
    session: str
    text: str = ""


@app.post("/api/plugins/interactive/start")
def plugins_isession_start(req: PluginRunReq):
    try:
        man, argv, cwd = _plugin_prepare(req.id, req.query)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    with _PLUGIN_SESS_LOCK:
        for sid in [s for s, v in _PLUGIN_SESSIONS.items() if not v.alive]:
            _PLUGIN_SESSIONS.pop(sid, None)
        if len(_PLUGIN_SESSIONS) >= _PLUGIN_SESS_MAX:
            return {"ok": False, "error": "too many interactive sessions open"}
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    try:
        proc = subprocess.Popen(
            argv, cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, bufsize=0, env=env, creationflags=NOWIN)
    except FileNotFoundError:
        return {"ok": False, "error": f"command not found: {argv[0]!r}"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    sid = uuid.uuid4().hex[:12]
    with _PLUGIN_SESS_LOCK:
        _PLUGIN_SESSIONS[sid] = _PlugSession(sid, proc, man)
    return {"ok": True, "session": sid, "command": " ".join(argv)}


@app.get("/api/plugins/interactive/stream")
def plugins_isession_stream(session: str):
    s = _PLUGIN_SESSIONS.get(session)

    def gen():
        if not s:
            yield _sse({"error": "no such session"})
            return
        try:
            while True:
                try:
                    item = s.q.get(timeout=0.5)
                except queue.Empty:
                    if time.time() - s.started > _PLUGIN_SESS_TTL:
                        yield _sse({"error": "session lifetime exceeded"})
                        return
                    yield ": keepalive\n\n"      # detects a dead client
                    continue
                if item is None:                # process exited
                    try:
                        code = s.proc.wait(timeout=2)
                    except Exception:
                        code = s.proc.poll()
                    yield _sse({"done": True, "code": code})
                    return
                yield _sse({"out": item})
        finally:
            # the output channel closing (exit, /stop, tab gone) ends the run
            s.stop()
            with _PLUGIN_SESS_LOCK:
                _PLUGIN_SESSIONS.pop(session, None)
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@app.post("/api/plugins/interactive/input")
def plugins_isession_input(req: PlugInputReq):
    s = _PLUGIN_SESSIONS.get(req.session)
    if not s or not s.alive:
        return {"ok": False, "error": "session not active"}
    try:
        s.send(req.text)
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.post("/api/plugins/interactive/stop")
def plugins_isession_stop(req: PlugSessionReq):
    s = _PLUGIN_SESSIONS.get(req.session)
    if s:
        s.stop()
    return {"ok": True}


def _plugin_rmtree(path: str) -> None:
    """Delete a plugin folder, clearing Windows read-only bits (pip leaves
    some in the .venv) on a retry rather than failing."""
    try:
        shutil.rmtree(path)
    except FileNotFoundError:
        return
    except Exception:
        if not os.path.exists(path):
            return
        for root, dirs, files in os.walk(path):
            for n in dirs + files:
                try:
                    os.chmod(os.path.join(root, n), 0o777)
                except OSError:
                    pass
        shutil.rmtree(path)                 # may still raise (locked) -> caller


@app.post("/api/plugins/delete")
def plugins_delete(req: PluginRunReq):
    """Fully remove a plugin: delete its ./plugins/<id> folder (manifest, tool
    files, and the isolated .venv). Confined to ./plugins via _plugin_dir."""
    try:
        path = _plugin_dir(req.id)          # validates id + confines to plugins
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    try:
        _plugin_rmtree(path)
    except Exception as e:
        return {"ok": False, "error": f"could not remove: {e} "
                "(is the tool still running?)"}
    return {"ok": True}


# ---- clone from GitHub + manifest editing --------------------------------
# Paste a repo URL -> git clone into ./plugins/<id> -> scaffold a starter
# aeye-plugin.json if the repo lacks one -> edit it inline -> install deps ->
# run. All inside the plugins tab. Cloning itself runs no repo code (git
# doesn't execute a cloned repo's hooks); execution stays gated behind the
# install/run buttons as before.

_GH_RE = re.compile(
    r"^https://github\.com/([A-Za-z0-9._-]+)/([A-Za-z0-9._-]+?)(?:\.git)?/?$")


def _guess_entry(dest: str) -> Optional[str]:
    """Best guess at a Python entry point in a freshly cloned repo root."""
    try:
        roots = [f for f in os.listdir(dest) if f.endswith(".py")]
    except OSError:
        return None
    for pref in ("main.py", "run.py", "cli.py", "app.py", "__main__.py"):
        if pref in roots:
            return pref
    base = os.path.basename(dest).lower()
    for f in roots:
        if f[:-3].lower() == base:
            return f
    return roots[0] if len(roots) == 1 else None


def _plugin_scaffold_manifest(dest: str, pid: str) -> bool:
    """Write a starter aeye-plugin.json if the repo didn't ship one. Returns
    True if it scaffolded (so the UI knows to open the editor)."""
    mpath = os.path.join(dest, "aeye-plugin.json")
    if os.path.isfile(mpath):
        return False
    entry = _guess_entry(dest)
    if entry:
        command = ["python", entry, "{query}"]
        desc = (f"Auto-scaffolded from GitHub (detected '{entry}'). Edit the "
                "command / trigger / mode to match the tool's real CLI.")
    else:
        command = ["python", "-c",
                   "print('Set the command in aeye-plugin.json')"]
        desc = ("Auto-scaffolded from GitHub -- no Python entry point found. "
                "Set the command / trigger / mode for this tool.")
    manifest = {"name": pid, "trigger": pid, "description": desc,
                "command": command, "mode": "stream"}
    with open(mpath, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    return True


class PluginCloneReq(BaseModel):
    url: str


@app.post("/api/plugins/clone")
def plugins_clone(req: PluginCloneReq):
    """git clone a GitHub repo into ./plugins, streaming git's output."""
    def gen():
        url = (req.url or "").strip()
        m = _GH_RE.match(url)
        if not m:
            yield _sse({"error": "paste a GitHub repo URL, e.g. "
                        "https://github.com/owner/repo"})
            return
        if not shutil.which("git"):
            yield _sse({"error": "git is not installed / not on PATH"})
            return
        owner, repo = m.group(1), m.group(2)
        pid = re.sub(r"[^A-Za-z0-9._-]", "-", repo).strip("-.").lower()[:64]
        if not pid or not _PLUGIN_ID_RE.match(pid):
            pid = "plugin-" + uuid.uuid4().hex[:6]
        root = os.path.realpath(PLUGINS_DIR)
        dest = os.path.realpath(os.path.join(PLUGINS_DIR, pid))
        if os.path.commonpath([dest, root]) != root:
            yield _sse({"error": "bad destination"})
            return
        if os.path.exists(dest):
            yield _sse({"error": f"'{pid}' already exists in plugins/ -- "
                        "remove it first"})
            return
        os.makedirs(PLUGINS_DIR, exist_ok=True)
        # rebuild the URL from the parsed owner/repo (never the raw string),
        # and `--` stops a repo name from being read as a git option
        clone_url = f"https://github.com/{owner}/{repo}.git"
        argv = ["git", "clone", "--depth", "1", "--", clone_url, dest]
        yield _sse({"status": "$ " + " ".join(argv)})
        env = os.environ.copy()
        env["GIT_TERMINAL_PROMPT"] = "0"     # fail, never hang on a credential prompt
        try:
            proc = subprocess.Popen(
                argv, cwd=PLUGINS_DIR, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                errors="replace", env=env, creationflags=NOWIN)
        except Exception as e:
            yield _sse({"error": f"{type(e).__name__}: {e}"})
            return
        deadline = time.time() + 600
        try:
            for line in proc.stdout:
                if time.time() > deadline:
                    proc.kill()
                    yield _sse({"error": "clone timed out"})
                    break
                yield _sse({"line": line.rstrip("\n")[:_PLUGIN_MAX_LINE]})
            code = proc.wait()
        except Exception as e:
            try:
                proc.kill()
            except Exception:
                pass
            code = -1
            yield _sse({"error": f"{type(e).__name__}: {e}"})
        if code != 0:
            try:
                _plugin_rmtree(dest)         # clean up a partial clone
            except Exception:
                pass
            yield _sse({"error": f"git clone failed (exit {code})"})
            return
        scaffolded = _plugin_scaffold_manifest(dest, pid)
        yield _sse({"line": "scaffolded aeye-plugin.json -- set the command/trigger"
                    if scaffolded else "repo already ships an aeye-plugin.json"})
        yield _sse({"done": True, "code": 0, "id": pid, "scaffolded": scaffolded})
    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


@app.get("/api/plugins/manifest")
def plugins_manifest_get(id: str):
    try:
        path = _plugin_dir(id)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    try:
        with open(os.path.join(path, "aeye-plugin.json"), encoding="utf-8") as f:
            return {"ok": True, "content": f.read()}
    except FileNotFoundError:
        return {"ok": True, "content": ""}   # allow authoring a fresh one
    except Exception as e:
        return {"ok": False, "error": str(e)}


class PluginManifestReq(BaseModel):
    id: str
    content: str


@app.post("/api/plugins/manifest")
def plugins_manifest_set(req: PluginManifestReq):
    try:
        path = _plugin_dir(req.id)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    try:
        parsed = json.loads(req.content)     # validate before writing
    except Exception as e:
        return {"ok": False, "error": f"invalid JSON: {e}"}
    if not isinstance(parsed, dict):
        return {"ok": False, "error": "manifest must be a JSON object"}
    try:
        mpath = os.path.join(path, "aeye-plugin.json")
        tmp = mpath + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(req.content)
        os.replace(tmp, mpath)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True}


# ---- author a plugin from scratch (code + manifest) in the UI ---------------
class PluginCreateReq(BaseModel):
    name: str
    trigger: str = ""
    filename: str = "plugin.py"
    code: str = ""
    command: list = []
    mode: str = "stream"
    description: str = ""
    requirements: str = ""


@app.post("/api/plugins/create")
def plugins_create(req: PluginCreateReq):
    """Create plugins/<id>/ with an entry file + a generated aeye-plugin.json."""
    pid = re.sub(r"[^A-Za-z0-9._-]", "-", (req.name or "").strip()).strip("-.").lower()[:64]
    if not pid or not _PLUGIN_ID_RE.match(pid):
        pid = "plugin-" + uuid.uuid4().hex[:6]
    root = os.path.realpath(PLUGINS_DIR)
    dest = os.path.realpath(os.path.join(PLUGINS_DIR, pid))
    if os.path.commonpath([dest, root]) != root:
        return {"ok": False, "error": "bad plugin id"}
    if os.path.exists(dest):
        return {"ok": False, "error": f"'{pid}' already exists -- pick another name"}
    trig = (req.trigger or "").strip()
    if not trig:
        return {"ok": False, "error": "a trigger is required"}
    fname = os.path.basename((req.filename or "").strip()) or "plugin.py"
    if fname.startswith(".") or fname == "aeye-plugin.json":
        return {"ok": False, "error": "bad entry file name"}
    cmd = (req.command if (isinstance(req.command, list) and req.command
                           and all(isinstance(x, str) for x in req.command))
           else ["python", fname, "{query}"])
    mode = req.mode if req.mode in ("stream", "terminal", "interactive") else "stream"
    try:
        os.makedirs(PLUGINS_DIR, exist_ok=True)
        os.makedirs(dest, exist_ok=False)
        with open(os.path.join(dest, fname), "w", encoding="utf-8", newline="") as f:
            f.write(req.code or "")
        manifest = {"name": ((req.name or pid).strip()[:80] or pid),
                    "trigger": trig[:60],
                    "description": (req.description or "").strip()[:300],
                    "command": cmd, "mode": mode}
        mtmp = os.path.join(dest, "aeye-plugin.json.tmp")
        with open(mtmp, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2, ensure_ascii=False)
        os.replace(mtmp, os.path.join(dest, "aeye-plugin.json"))
        reqs = (req.requirements or "").strip()
        if reqs:
            with open(os.path.join(dest, "requirements.txt"), "w",
                      encoding="utf-8", newline="") as f:
                f.write(reqs + "\n")
    except Exception as e:
        try:
            _plugin_rmtree(dest)
        except Exception:
            pass
        return {"ok": False, "error": str(e)}
    return {"ok": True, "id": pid, "filename": fname}


@app.get("/api/plugins/files")
def plugins_files(id: str):
    """Top-level files in a plugin's folder, for the editor's file picker."""
    try:
        path = _plugin_dir(id)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    out = []
    try:
        for e in sorted(os.listdir(path)):
            if e in (".venv", "__pycache__") or e.endswith(".tmp"):
                continue
            if os.path.isfile(os.path.join(path, e)):
                out.append(e)
    except OSError:
        pass
    return {"ok": True, "files": out}


@app.get("/api/plugins/file")
def plugins_file_get(id: str, name: str):
    try:
        path = _plugin_file_path(id, name, must_exist=True)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    try:
        with open(path, encoding="utf-8") as f:
            return {"ok": True, "content": f.read()}
    except Exception as e:
        return {"ok": False, "error": str(e)}


class PluginFileReq(BaseModel):
    id: str
    name: str
    content: str


@app.post("/api/plugins/file")
def plugins_file_set(req: PluginFileReq):
    # the manifest is JSON-validated by its own endpoint -- keep it out of here
    if os.path.basename((req.name or "").strip()) == "aeye-plugin.json":
        return {"ok": False, "error": "edit the manifest with the manifest editor"}
    try:
        path = _plugin_file_path(req.id, req.name)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    try:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="") as f:
            f.write(req.content)
        os.replace(tmp, path)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True}


@app.get("/api/hardware")
def hardware():
    return scan_hardware()


@app.get("/api/stats")
def stats():
    """Live CPU / RAM / GPU / VRAM / network usage for the header meters."""
    _LAST_STATS_REQ["t"] = time.time()
    return _sys_stats()


_last_served_total = None


@app.get("/api/catalog")
def catalog():
    global _last_served_total
    hw = scan_hardware()
    refresh = _refresh_snapshot()
    with REFRESH.lock:
        dynamic = list(REFRESH.dynamic)
    # NO filtering here -- every static + dynamic model is returned; `fit` is only
    # a hardware tag (FITS GPU / CPU ONLY / TOO BIG), never an exclusion.
    models = [{**m, "fit": _fit(m, hw)} for m in CATALOG + dynamic]
    total = len(models)
    if total != _last_served_total:            # log only when the count changes
        _last_served_total = total
        unc = sum(1 for m in models if m.get("cat") == "uncensored")
        _catlog("/api/catalog served {} models = {} static + {} dynamic "
                "({} uncensored, none filtered)".format(total, len(CATALOG), len(dynamic), unc))
    return {"hw": hw, "models": models, "refresh": refresh}


@app.get("/api/refresh/status")
def refresh_status():
    return _refresh_snapshot()


@app.post("/api/refresh")
def refresh_now():
    with REFRESH.lock:
        if REFRESH.state == "running":
            return {"ok": False, "error": "a refresh is already running"}
    threading.Thread(target=_refresh_catalog, daemon=True).start()
    return {"ok": True}


@app.get("/api/search")
async def search(q: str = "", limit: int = 25):
    """Search the full HuggingFace Hub and the Ollama library, regardless of
    whether the result fits the local hardware. HF GGUF repos come back with a
    quant list + a ready `hf.co/...` pull name for Ollama."""
    q = (q or "").strip()
    if not q:
        return {"q": q, "hf": [], "ollama": [], "errors": {}}
    limit = max(1, min(int(limit or 25), 50))
    hf, ollama, errors = [], [], {}

    async with httpx.AsyncClient(timeout=15, follow_redirects=True,
                                 headers={"User-Agent": "AEYE/1.0"}) as client:
        # --- HuggingFace Hub (full=true gives us siblings + tags in one call)
        try:
            r = await client.get("https://huggingface.co/api/models", params={
                "search": q, "limit": limit, "full": "true", "config": "false"})
            if r.status_code == 200:
                hf = [_normalize_hf(m) for m in r.json()]
            else:
                errors["hf"] = f"HTTP {r.status_code}"
        except Exception as e:
            errors["hf"] = f"{type(e).__name__}: {e}"

        # --- Ollama library (no JSON API; scrape /library/<name> links)
        try:
            r = await client.get("https://ollama.com/search", params={"q": q},
                                  headers={"User-Agent": "Mozilla/5.0"})
            if r.status_code == 200:
                seen = []
                for n in re.findall(r'href="/library/([^"?#]+)"', r.text):
                    if n not in seen:
                        seen.append(n)
                ollama = seen[:limit]
            else:
                errors["ollama"] = f"HTTP {r.status_code}"
        except Exception as e:
            errors["ollama"] = f"{type(e).__name__}: {e}"

    return {"q": q, "hf": hf, "ollama": ollama, "errors": errors}


@app.post("/api/ollama/show")
async def ollama_show(req: ShowReq):
    """Fetch the Modelfile of an installed Ollama model."""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(f"{OLLAMA}/api/show", json={"name": req.name})
            if r.status_code != 200:
                return {"ok": False, "error": f"ollama HTTP {r.status_code}: {r.text[:200]}"}
            return {"ok": True, "modelfile": r.json().get("modelfile", "")}
    except Exception as e:
        return {"ok": False, "error": f"cannot reach Ollama: {e}"}


@app.post("/api/ollama/create")
def ollama_create(req: CreateReq):
    """Run `ollama create <name> -f <modelfile>` and stream the CLI output.

    Shells out to the CLI (rather than POSTing /api/create) so any Modelfile
    the CLI can parse works, regardless of the Ollama API version.
    """
    def gen():
        if not shutil.which("ollama"):
            yield _sse({"error": "ollama CLI not found on PATH -- install Ollama first"})
            return
        # a (re)created model may carry a new SYSTEM -- drop any cached copy so
        # _ollama_model_system re-reads it on the next chat
        with _MODEL_SYS_LOCK:
            _MODEL_SYS_CACHE.pop(req.name, None)
            _MODEL_SYS_CACHE.pop(req.name + ":latest", None)
        fd, path = tempfile.mkstemp(suffix=".Modelfile", text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(req.modelfile)
            proc = subprocess.Popen(
                ["ollama", "create", req.name, "-f", path],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace",
                creationflags=NOWIN)
            ansi = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
            for line in proc.stdout:
                line = ansi.sub("", line).strip()
                if line:
                    yield _sse({"status": line})
            code = proc.wait()
            if code == 0:
                yield _sse({"done": True})
            else:
                yield _sse({"error": f"ollama create exited with code {code}"})
        except Exception as e:
            yield _sse({"error": f"{type(e).__name__}: {e}"})
        finally:
            try:
                os.remove(path)
            except OSError:
                pass
    return StreamingResponse(gen(), media_type="text/event-stream")


@app.get("/api/models")
async def models():
    out = {"ollama": [], "ollama_online": False}
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{OLLAMA}/api/tags")
            out["ollama"] = sorted(m["name"] for m in r.json().get("models", []))
            out["ollama_online"] = True
    except Exception:
        pass
    with HF.lock:
        out["hf"] = {
            "available": hf_available(),
            "state": HF.state,
            "model_id": HF.model_id,
            "error": HF.error,
            "device": HF.device,
            "elapsed": round(time.time() - HF.started, 1) if HF.started else None,
        }
    with IMG.lock:
        out["img"] = {
            "available": img_available(),
            "state": IMG.state,
            "model_id": IMG.model_id,
            "error": IMG.error,
            "device": IMG.device,
            "elapsed": round(time.time() - IMG.started, 1) if IMG.started else None,
        }
    with VID.lock:
        out["vid"] = {
            "available": vid_available(),
            "state": VID.state,
            "model_id": VID.model_id,
            "error": VID.error,
            "device": VID.device,
            "elapsed": round(time.time() - VID.started, 1) if VID.started else None,
        }
    return out


@app.get("/api/installed")
def installed():
    """Everything actually downloaded on disk -- for the de-bloat trashcan."""
    ol, online = _ollama_installed()
    hf, hf_total, hf_err = _hf_cache_repos()
    return {"ollama": ol, "ollama_online": online,
            "hf": hf, "hf_total_gb": hf_total, "hf_error": hf_err}


@app.post("/api/ollama/delete")
async def ollama_delete(req: PullReq):
    """Remove an installed Ollama model (frees its disk space)."""
    try:
        async with httpx.AsyncClient(timeout=30) as client:
            r = await client.request(
                "DELETE", f"{OLLAMA}/api/delete",
                json={"name": req.name, "model": req.name})
        if r.status_code == 200:
            return {"ok": True}
        return {"ok": False, "error": f"ollama HTTP {r.status_code}: {r.text[:200]}"}
    except Exception as e:
        return {"ok": False, "error": f"cannot reach Ollama: {e}"}


@app.post("/api/hf/delete")
def hf_delete(req: HFDeleteReq):
    """Delete a cached HuggingFace repo from disk (unloads it first if active)."""
    try:
        from huggingface_hub import scan_cache_dir
    except Exception:
        return {"ok": False, "error": "huggingface_hub not available"}
    with HF.lock:
        if HF.model_id == req.repo:
            HF.model = HF.tokenizer = None
            HF.state, HF.model_id, HF.error, HF.started = "idle", None, None, None
    with IMG.lock:
        if IMG.model_id == req.repo:
            IMG.pipe = None
            IMG.state, IMG.model_id, IMG.error, IMG.started = "idle", None, None, None
    try:
        import gc
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    try:
        cache = scan_cache_dir()
        hashes = [rev.commit_hash for r in cache.repos
                  if r.repo_type == "model" and r.repo_id == req.repo
                  for rev in r.revisions]
        if not hashes:
            return {"ok": False, "error": f"'{req.repo}' is not in the cache"}
        strategy = cache.delete_revisions(*hashes)
        freed = strategy.expected_freed_size / 2**30
        strategy.execute()
        return {"ok": True, "freed_gb": round(freed, 2)}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@app.post("/api/hf/load")
def hf_load(req: HFLoadReq):
    if not hf_available():
        return {"ok": False, "error": f"HuggingFace support not installed -- {_extras_hint()}"}
    with HF.lock:
        if HF.state == "loading":
            return {"ok": False, "error": "A model is already loading"}
        HF.model = HF.tokenizer = None
        HF.state, HF.model_id, HF.error = "loading", req.model_id, None
        HF.started = time.time()
    threading.Thread(target=_hf_load,
                     args=(req.model_id, req.four_bit, req.trust_remote_code),
                     daemon=True).start()
    return {"ok": True}


@app.post("/api/hf/unload")
def hf_unload():
    with HF.lock:
        HF.model = HF.tokenizer = None
        HF.state, HF.model_id, HF.error, HF.started = "idle", None, None, None
    _save_state(last_hf_model=None)   # an explicit unload opts out of auto-reload
    try:
        import gc
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    return {"ok": True}


@app.post("/api/img/load")
def img_load(req: ImgLoadReq):
    if not img_available():
        return {"ok": False, "error": f"image generation not installed -- {_extras_hint()}"}
    with IMG.lock:
        if IMG.state in ("loading", "busy"):
            return {"ok": False, "error": f"pipeline is {IMG.state}"}
        IMG.pipe = None
        IMG.state, IMG.model_id, IMG.error = "loading", req.model_id, None
        IMG.started = time.time()
    threading.Thread(target=_img_load, args=(req.model_id,), daemon=True).start()
    return {"ok": True}


@app.post("/api/img/unload")
def img_unload():
    with IMG.lock:
        # never free the pipe / CUDA cache mid-generation or mid-load -- it would
        # crash the in-flight call
        if IMG.state in ("busy", "loading"):
            return {"ok": False,
                    "error": f"can't unload while {IMG.state} -- wait for it to finish"}
        IMG.pipe = None
        IMG.state, IMG.model_id, IMG.error, IMG.started = "idle", None, None, None
    _save_state(last_image_model=None)   # an explicit unload opts out of auto-reload
    try:
        import gc
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    return {"ok": True}


def _cuda_gc() -> None:
    try:
        import gc
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


@app.post("/api/img/generate")
def img_generate(req: ImgGenReq):
    with IMG.lock:
        if IMG.state != "ready":
            return {"ok": False, "error": "no image model loaded -- load one from the library first"}
        IMG.state = "busy"

    def _run():
        return _img_generate(req.prompt, req.negative, req.steps, req.guidance,
                             req.width, req.height, req.seed)
    try:
        try:
            url = _run()
        except Exception as e:
            if not _is_oom(e):
                raise
            # VRAM OOM -> free, reload THIS model at the lightest (sequential)
            # offload tier, and retry once before giving up
            model_id = IMG.model_id
            _cuda_gc()
            _img_load(model_id, force_offload="sequential")
            if IMG.state != "ready":
                return {"ok": False,
                        "error": IMG.error or "out of VRAM (offload retry failed)"}
            with IMG.lock:
                IMG.state = "busy"
            url = _run()
        return {"ok": True, "image": url}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        with IMG.lock:
            if IMG.state == "busy":
                IMG.state = "ready"


@app.post("/api/vid/load")
def vid_load(req: VidLoadReq):
    if not vid_available():
        return {"ok": False, "error": f"video generation not installed -- {_extras_hint()}"}
    with VID.lock:
        if VID.state in ("loading", "busy"):
            return {"ok": False, "error": f"pipeline is {VID.state}"}
        VID.pipe = None
        VID.state, VID.model_id, VID.error = "loading", req.model_id, None
        VID.started = time.time()
    threading.Thread(target=_vid_load, args=(req.model_id,), daemon=True).start()
    return {"ok": True}


@app.post("/api/vid/unload")
def vid_unload():
    with VID.lock:
        if VID.state in ("busy", "loading"):
            return {"ok": False,
                    "error": f"can't unload while {VID.state} -- wait for it to finish"}
        VID.pipe = None
        VID.state, VID.model_id, VID.error, VID.started = "idle", None, None, None
    _save_state(last_video_model=None)   # an explicit unload opts out of auto-reload
    try:
        import gc
        import torch
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass
    return {"ok": True}


@app.post("/api/vid/generate")
def vid_generate(req: VidGenReq):
    with VID.lock:
        if VID.state != "ready":
            return {"ok": False, "error": "no video model loaded -- load one from the library first"}
        VID.state = "busy"

    def _run():
        return _vid_generate(req.prompt, req.negative, req.steps,
                             req.guidance, req.num_frames, req.fps,
                             req.width, req.height, req.seed)
    try:
        try:
            url, mime = _run()
        except Exception as e:
            if not _is_oom(e):
                raise
            model_id = VID.model_id
            _cuda_gc()
            _vid_load(model_id, force_offload="sequential")
            if VID.state != "ready":
                return {"ok": False,
                        "error": VID.error or "out of VRAM (offload retry failed)"}
            with VID.lock:
                VID.state = "busy"
            url, mime = _run()
        return {"ok": True, "video": url, "mime": mime}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        with VID.lock:
            if VID.state == "busy":
                VID.state = "ready"


@app.get("/api/autoload/options")
def autoload_options():
    """What the startup picker can restore: the last-used model per category and
    whether it's still cached on disk (so we never offer a silent re-download).
    Nothing loads on startup -- the user chooses here."""
    st = _load_state()
    cached = set()
    try:
        repos, _, _ = _hf_cache_repos()
        cached = {r["repo"] for r in repos}
    except Exception:
        pass

    def opt(key: str, avail: bool) -> dict:
        mid = st.get(key)
        return {"model": mid, "available": avail,
                "cached": bool(mid) and mid in cached}

    return {
        "chat":  opt("last_hf_model", hf_available()),
        "image": opt("last_image_model", img_available()),
        "video": opt("last_video_model", vid_available()),
    }


@app.post("/api/autoload")
def autoload(req: AutoloadReq):
    """Restore the chosen categories' last-used models, sequentially (loading
    several at once fights over VRAM). Fire-and-forget in a thread; the frontend
    polls /api/models to watch each badge come up."""
    def _run():
        if req.chat:
            _autoreload_hf()
        if req.image:
            _autoreload_image()
        if req.video:
            _autoreload_video()
    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True}


# --------------------------------------------------------------------------
# Speech-to-text -- LOCAL Whisper via faster-whisper. Mirrors the Piper stance:
# the model downloads once from HuggingFace, then transcription is 100% on this
# machine (no audio ever leaves it). Runs on CPU/int8 so it never fights the
# LLM for VRAM. Optional install -- the mic button disables itself without it.
# --------------------------------------------------------------------------

class WhisperState:
    def __init__(self):
        self.lock = threading.Lock()
        self.model = None
        self.state = "idle"          # idle | loading | ready | error
        self.error: Optional[str] = None


WHISPER = WhisperState()
# faster-whisper's model isn't safe for concurrent transcribe() calls -- the
# live-dictation preview fires overlapping requests, so serialize inference.
_WHISPER_INFER = threading.Lock()


def stt_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        return False


def _whisper_load():
    """Lazily load (and, first time, download) the Whisper model. Returns the
    model or raises. Concurrent callers share the one instance."""
    with WHISPER.lock:
        if WHISPER.model is not None:
            return WHISPER.model
        if WHISPER.state == "loading":
            busy = True
        else:
            WHISPER.state, WHISPER.error, busy = "loading", None, False
    if busy:                                   # another thread is loading it
        for _ in range(600):                   # wait up to ~60 s
            time.sleep(0.1)
            with WHISPER.lock:
                if WHISPER.model is not None:
                    return WHISPER.model
                if WHISPER.state == "error":
                    raise RuntimeError(WHISPER.error or "whisper load failed")
        raise RuntimeError("whisper load timed out")
    try:
        from faster_whisper import WhisperModel
        m = WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")
        with WHISPER.lock:
            WHISPER.model, WHISPER.state = m, "ready"
        return m
    except Exception as e:
        with WHISPER.lock:
            WHISPER.state, WHISPER.error = "error", f"{type(e).__name__}: {e}"
        raise


def _whisper_transcribe(audio: bytes) -> dict:
    try:
        model = _whisper_load()
    except Exception as e:
        return {"ok": False, "error": f"whisper unavailable: {e}"}
    tmp = tempfile.NamedTemporaryFile(suffix=".webm", delete=False)
    try:
        tmp.write(audio)
        tmp.close()
        with _WHISPER_INFER:                     # one transcription at a time
            segments, info = model.transcribe(tmp.name, beam_size=5, vad_filter=True)
            text = " ".join(s.text.strip() for s in segments).strip()
        return {"ok": True, "text": text, "lang": getattr(info, "language", None)}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    finally:
        try:
            os.remove(tmp.name)
        except OSError:
            pass


@app.get("/api/stt/info")
def stt_info():
    with WHISPER.lock:
        return {"available": stt_available(), "model": WHISPER_MODEL,
                "state": WHISPER.state, "error": WHISPER.error}


@app.post("/api/stt/warm")
def stt_warm():
    """Kick a background model load so the first real transcription is fast."""
    if not stt_available():
        return {"ok": False, "error": "faster-whisper not installed"}
    with WHISPER.lock:
        idle = WHISPER.model is None and WHISPER.state != "loading"
    if idle:
        threading.Thread(target=lambda: _whisper_load_safe(), daemon=True).start()
    return {"ok": True}


def _whisper_load_safe():
    try:
        _whisper_load()
    except Exception:
        pass


@app.post("/api/stt")
async def stt(request: Request):
    if not stt_available():
        return {"ok": False,
                "error": f"speech-to-text not installed -- {_extras_hint()}"}
    audio = await request.body()
    if not audio:
        return {"ok": False, "error": "no audio received"}
    # transcription is blocking (and may download the model) -- off the loop
    return await asyncio.to_thread(_whisper_transcribe, audio)


@app.get("/api/tts/voices")
def tts_voices():
    avail = piper_available()
    voices = [{**v, "downloaded": (avail and _piper_is_local(v["key"]))}
              for v in PIPER_VOICES]
    with PIPER.lock:
        dl = {"state": PIPER.dl_state, "key": PIPER.dl_key, "error": PIPER.dl_error,
              "elapsed": round(time.time() - PIPER.dl_started, 1) if PIPER.dl_started else None}
    effects = list(TTS_EFFECTS.keys())
    if pedalboard_available():
        effects += list(HORROR_EFFECTS.keys())   # horror chains (goblin etc. stay too)
    return {"available": avail, "voices": voices, "download": dl,
            "effects": effects, "horror": list(HORROR_EFFECTS.keys())}


@app.post("/api/tts/download")
def tts_download(req: TTSDownloadReq):
    if not piper_available():
        return {"ok": False, "error": f"Piper TTS not available -- {_extras_hint()}"}
    if req.key not in PIPER_INDEX:
        return {"ok": False, "error": f"unknown voice '{req.key}'"}
    with PIPER.lock:
        if PIPER.dl_state == "downloading":
            return {"ok": False, "error": "a voice is already downloading"}
        PIPER.dl_state, PIPER.dl_key, PIPER.dl_error = "downloading", req.key, None
        PIPER.dl_started = time.time()
    threading.Thread(target=_piper_download, args=(req.key,), daemon=True).start()
    return {"ok": True}


@app.post("/api/tts/delete")
def tts_delete(req: TTSDownloadReq):
    """Delete a downloaded Piper voice (its onnx + json blobs) to free space.
    Voices share one HF repo, so we remove the individual files, not the repo."""
    if req.key not in PIPER_INDEX:
        return {"ok": False, "error": f"unknown voice '{req.key}'"}
    try:
        onnx, cfg = _piper_files(req.key, download=False)
    except Exception:
        return {"ok": False, "error": "voice is not downloaded"}
    # each snapshot file is a symlink into a content-addressed blob; count the
    # blob once, then remove both the link and the blob it points to.
    reals = {os.path.realpath(p) for p in (onnx, cfg)}
    freed = 0
    for real in reals:
        try:
            freed += os.path.getsize(real)
        except OSError:
            pass
    for p in (onnx, cfg):
        for target in {p, os.path.realpath(p)}:
            try:
                os.remove(target)
            except OSError:
                pass
    with PIPER.lock:
        PIPER.cache.pop(onnx, None)
    return {"ok": True, "freed_gb": round(freed / 2**30, 3)}


@app.post("/api/tts/speak")
def tts_speak(req: TTSSpeakReq):
    if not piper_available():
        return Response("Piper not installed", status_code=503)
    if req.key not in PIPER_INDEX:
        return Response("unknown voice", status_code=400)
    if not _piper_is_local(req.key):
        return Response("voice not downloaded", status_code=409)
    text = (req.text or "").strip()
    if not text:
        return Response("empty text", status_code=400)
    # Web Audio streaming plays chunks gaplessly and doesn't clip the start.
    #   flow   -> mid-phrase word-run (shuffle): tightest, no sentence prosody
    #   stream -> a whole sentence: short tail for a natural inter-sentence gap
    #   else   -> single utterance: full edge padding
    if req.flow:
        lead_ms, tail_ms, terminal = 0, 15, False
    elif req.stream:
        lead_ms, tail_ms, terminal = 0, 90, True
    else:
        lead_ms, tail_ms, terminal = 200, 250, True
    try:
        wav = _piper_synth(req.key, text, req.length_scale, req.effect,
                           lead_ms=lead_ms, tail_ms=tail_ms,
                           terminal_punct=terminal, beep_words=req.beep_words)
        return Response(wav, media_type="audio/wav")
    except Exception as e:
        return Response(f"{type(e).__name__}: {e}", status_code=500)


@app.post("/api/ollama/pull")
async def ollama_pull(req: PullReq):
    """Proxy `ollama pull` and forward its progress as SSE."""
    async def gen():
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream(
                    "POST", f"{OLLAMA}/api/pull", json={"name": req.name, "stream": True}
                ) as r:
                    async for line in r.aiter_lines():
                        if line.strip():
                            yield f"data: {line}\n\n"
            yield _sse({"done": True})
        except Exception as e:
            yield _sse({"error": f"pull failed: {e}"})
    return StreamingResponse(gen(), media_type="text/event-stream")


#: hard ceiling for the automatic context bump, so a runaway prompt can't try
#: to allocate an absurd KV-cache. Users can still set num_ctx higher by hand.
_CTX_AUTO_MAX = 32768


def _needed_ctx(body: str) -> Optional[int]:
    """Pull n_prompt_tokens out of an Ollama 'exceeds context size' error.
    The body is JSON-in-JSON, so the quotes arrive escaped (\\"n_prompt_tokens\\")
    -- match the key then the first number regardless of escaping."""
    m = re.search(r'n_prompt_tokens\D*?(\d+)', body or "")
    if m:
        return int(m.group(1))
    # fallback: '... request (12345 tokens) exceeds ...'
    m = re.search(r'request\s*\((\d+)\s*tokens?\)\s*exceeds', body or "")
    return int(m.group(1)) if m else None


# --- keep a user's modelfile SYSTEM authoritative ---------------------------
# Ollama applies a model's baked-in SYSTEM only when the request carries NO
# system message. AEYE injects a system message for web/docs/memory context,
# which silently overrides the modelfile persona. So we read the model's own
# SYSTEM and re-inject it, marked as top priority, whenever we're also sending
# context -- the modelfile instruction then wins over everything else.
_MODEL_SYS_CACHE: dict = {}
_MODEL_SYS_LOCK = threading.Lock()


async def _ollama_model_system(model: str) -> str:
    """The SYSTEM baked into an Ollama model's modelfile (''/none if unset).
    Cached per model; invalidated when a model is (re)created."""
    if not model:
        return ""
    with _MODEL_SYS_LOCK:
        if model in _MODEL_SYS_CACHE:
            return _MODEL_SYS_CACHE[model]
    sys_txt = ""
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            r = await client.post(f"{OLLAMA}/api/show", json={"name": model})
            if r.status_code == 200:
                sys_txt = (r.json().get("system") or "").strip()
    except Exception:
        sys_txt = ""
    with _MODEL_SYS_LOCK:
        _MODEL_SYS_CACHE[model] = sys_txt
    return sys_txt


async def _merge_modelfile_system(req: ChatReq) -> list:
    """If the request opens with an injected system message, prepend the model's
    own modelfile SYSTEM (marked authoritative) so enabling web/docs/memory
    never wipes a user's custom persona. No-op when there's no injected system
    message (Ollama applies the modelfile SYSTEM itself) or the model has none."""
    msgs = req.messages
    if not msgs or msgs[0].get("role") != "system":
        return msgs
    msys = await _ollama_model_system(req.model)
    if not msys or msys in (msgs[0].get("content") or ""):
        return msgs
    merged = (msys
              + "\n\n[The directive above is your core identity and takes "
                "precedence over every instruction that follows.]\n\n"
              + msgs[0]["content"])
    return [{"role": "system", "content": merged}] + msgs[1:]


async def _ollama_chat(req: ChatReq):
    num_ctx = max(int(req.num_ctx or 16384), 512)
    messages = await _merge_modelfile_system(req)
    bumped = False
    while True:
        payload = {
            "model": req.model,
            "messages": messages,
            "stream": True,
            "options": {"temperature": req.temperature,
                        "num_predict": req.max_tokens,
                        "num_ctx": num_ctx},
        }
        try:
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", f"{OLLAMA}/api/chat", json=payload) as r:
                    if r.status_code != 200:
                        body = (await r.aread()).decode(errors="ignore")
                        # auto-fit: if the prompt just needs a bigger window, grow
                        # num_ctx to hold prompt + reply and retry once.
                        need = _needed_ctx(body)
                        if need and not bumped and need > num_ctx:
                            reply = req.max_tokens if req.max_tokens > 0 else 2048
                            want = need + reply + 512
                            want = ((want + 2047) // 2048) * 2048   # round to 2K
                            num_ctx = min(max(want, num_ctx), _CTX_AUTO_MAX)
                            bumped = True
                            if num_ctx >= need:
                                continue                    # retry with the bump
                        yield _sse({"error": f"ollama HTTP {r.status_code}: {body[:300]}"})
                        return
                    async for line in r.aiter_lines():
                        if not line.strip():
                            continue
                        data = json.loads(line)
                        if data.get("error"):
                            yield _sse({"error": data["error"]})
                            return
                        msg = data.get("message", {})
                        # reasoning models stream their chain-of-thought in a
                        # separate 'thinking' field -- surface it dimmed so the
                        # eye visibly works instead of appearing to hang.
                        think = msg.get("thinking")
                        if think:
                            yield _sse({"thinking": think})
                        token = msg.get("content", "")
                        if token:
                            yield _sse({"token": token})
                        if data.get("done"):
                            break
            yield _sse({"done": True})
            return
        except httpx.ConnectError:
            yield _sse({"error": f"cannot reach Ollama at {OLLAMA} -- is it running?"})
            return
        except Exception as e:
            yield _sse({"error": f"{type(e).__name__}: {e}"})
            return


def _hf_chat(req: ChatReq):
    try:
        if HF.state != "ready":
            yield _sse({"error": "no HuggingFace model is loaded"})
            return
        for piece in _hf_stream(req.messages, req.max_tokens, req.temperature):
            yield _sse({"token": piece})
        yield _sse({"done": True})
    except Exception as e:
        yield _sse({"error": f"{type(e).__name__}: {e}"})


@app.post("/api/chat")
async def chat(req: ChatReq):
    if req.backend == "ollama":
        gen = _ollama_chat(req)
    elif req.backend == "hf":
        gen = _hf_chat(req)  # sync generator -- starlette runs it in a threadpool
    else:
        async def bad():
            yield _sse({"error": f"unknown backend '{req.backend}'"})
        gen = bad()
    return StreamingResponse(gen, media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# --------------------------------------------------------------------------
# Chat memory (OPT-IN): saved conversations + projects, plain local JSON under
# ./memory. The server never writes a chat on its own -- every write comes
# from an explicit frontend call, and the frontend only calls when the user
# has flipped the MEMORY toggle on. Off (the default) keeps the original
# no-chat-logging posture. Nothing here ever leaves the machine.
#
# Layout:  memory/chats/<id>.json   one conversation per file
#          memory/projects.json     [{id, name, created}]
# A chat file: {id, title, project_id, created, updated, messages,
#               summary, summary_upto}. `summary` is a model-written briefing
#  so a resumed chat re-reads a paragraph, not the whole transcript;
# `summary_upto` = how many messages it covers (< len(messages) = stale).
# --------------------------------------------------------------------------

MEM_DIR = paths.MEMORY_DIR
MEM_CHATS_DIR = os.path.join(MEM_DIR, "chats")
MEM_PROJECTS_FILE = os.path.join(MEM_DIR, "projects.json")
_MEM_LOCK = threading.Lock()
_MEM_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")


def _mem_path(cid: str) -> str:
    if not _MEM_ID_RE.match(cid or ""):
        raise ValueError("bad chat id")
    return os.path.join(MEM_CHATS_DIR, cid + ".json")


def _mem_read(cid: str) -> Optional[dict]:
    try:
        with open(_mem_path(cid), encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _mem_write(chat: dict) -> None:
    os.makedirs(MEM_CHATS_DIR, exist_ok=True)
    path = _mem_path(chat["id"])
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(chat, f, ensure_ascii=False)
    os.replace(tmp, path)


def _mem_meta(chat: dict) -> dict:
    """Everything but the transcript -- summaries ride along so the frontend
    can build memory context without fetching each chat."""
    return {k: chat.get(k) for k in
            ("id", "title", "project_id", "created", "updated",
             "summary", "summary_upto")} | {"n": len(chat.get("messages", []))}


def _mem_list() -> list:
    metas = []
    try:
        names = os.listdir(MEM_CHATS_DIR)
    except OSError:
        return metas
    for name in names:
        if name.endswith(".json"):
            chat = _mem_read(name[:-5])
            if chat:
                metas.append(_mem_meta(chat))
    metas.sort(key=lambda m: m.get("updated") or 0, reverse=True)
    return metas


def _mem_projects() -> list:
    try:
        with open(MEM_PROJECTS_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _mem_write_projects(projects: list) -> None:
    os.makedirs(MEM_DIR, exist_ok=True)
    tmp = MEM_PROJECTS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(projects, f, ensure_ascii=False)
    os.replace(tmp, MEM_PROJECTS_FILE)


class MemSaveReq(BaseModel):
    id: Optional[str] = None
    title: Optional[str] = None
    append: list = []


class MemIdReq(BaseModel):
    id: str


class MemAssignReq(BaseModel):
    id: str
    project_id: Optional[str] = None


class MemProjectReq(BaseModel):
    name: str


class MemSummarizeReq(BaseModel):
    id: str
    backend: str = "ollama"
    model: Optional[str] = None
    num_ctx: int = 8192


@app.get("/api/memory/list")
def memory_list():
    return {"chats": _mem_list(), "projects": _mem_projects()}


@app.get("/api/memory/chat")
def memory_chat(id: str):
    chat = _mem_read(id)
    return chat if chat else {"error": "no such chat"}


@app.post("/api/memory/save")
def memory_save(req: MemSaveReq):
    """Create a chat (no id) or append new messages to one (id). The frontend
    sends only the messages it hasn't saved yet; system messages (injected
    memory context) and attachment payloads are dropped here so a resumed
    chat never re-saves its own briefing."""
    msgs = [{"role": m.get("role"), "content": str(m.get("content") or "")}
            for m in (req.append or []) if isinstance(m, dict)]
    msgs = [m for m in msgs
            if m["role"] in ("user", "assistant") and m["content"].strip()]
    with _MEM_LOCK:
        if req.id:
            chat = _mem_read(req.id)
            if not chat:
                return {"ok": False, "error": "no such chat"}
        else:
            if not msgs:
                return {"ok": False, "error": "nothing to save"}
            chat = {"id": time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6],
                    "title": "", "project_id": None, "created": time.time(),
                    "summary": "", "summary_upto": 0, "messages": []}
        chat["messages"].extend(msgs)
        if req.title:
            chat["title"] = req.title.strip()[:80]
        if not chat["title"]:
            first = next((m for m in chat["messages"] if m["role"] == "user"), None)
            chat["title"] = (first["content"].strip()[:60] if first else "untitled")
        chat["updated"] = time.time()
        try:
            _mem_write(chat)
        except Exception as e:
            return {"ok": False, "error": str(e)}
    return {"ok": True, "chat": _mem_meta(chat)}


@app.post("/api/memory/delete")
def memory_delete(req: MemIdReq):
    try:
        os.remove(_mem_path(req.id))
        return {"ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e)}


@app.post("/api/memory/assign")
def memory_assign(req: MemAssignReq):
    with _MEM_LOCK:
        chat = _mem_read(req.id)
        if not chat:
            return {"ok": False, "error": "no such chat"}
        pid = req.project_id or None
        if pid and not any(p["id"] == pid for p in _mem_projects()):
            return {"ok": False, "error": "no such project"}
        chat["project_id"] = pid
        _mem_write(chat)
    return {"ok": True, "chat": _mem_meta(chat)}


@app.post("/api/memory/project")
def memory_project_create(req: MemProjectReq):
    name = (req.name or "").strip()[:60]
    if not name:
        return {"ok": False, "error": "empty name"}
    with _MEM_LOCK:
        projects = _mem_projects()
        if any(p["name"].lower() == name.lower() for p in projects):
            return {"ok": False, "error": "a project with that name exists"}
        proj = {"id": uuid.uuid4().hex[:8], "name": name, "created": time.time()}
        projects.append(proj)
        _mem_write_projects(projects)
    return {"ok": True, "project": proj}


@app.post("/api/memory/project/delete")
def memory_project_delete(req: MemIdReq):
    with _MEM_LOCK:
        projects = [p for p in _mem_projects() if p["id"] != req.id]
        _mem_write_projects(projects)
        # orphaned chats fall back to unassigned (they are NOT deleted)
        for meta in _mem_list():
            if meta.get("project_id") == req.id:
                chat = _mem_read(meta["id"])
                if chat:
                    chat["project_id"] = None
                    _mem_write(chat)
    return {"ok": True}


_SUMMARY_SYS = (
    "You are writing a memory briefing for yourself so you can pick this "
    "conversation up later without rereading it. In under 200 words of plain "
    "text, capture: the topics discussed, key facts and decisions, unresolved "
    "questions, and any preferences the user expressed. Output ONLY the briefing.")


def _mem_transcript(msgs: list, limit_chars: int = 9000) -> str:
    parts = []
    for m in msgs:
        who = "USER" if m.get("role") == "user" else "ASSISTANT"
        parts.append(who + ": " + (m.get("content") or "")[:1500])
    return "\n".join(parts)[-limit_chars:]


def _gen_once(backend: str, model: Optional[str], messages: list,
              max_tokens: int = 400, num_ctx: int = 8192) -> str:
    """One non-streaming completion on whichever backend the UI is using --
    powers summaries. Low temperature: briefings should be dry, not creative."""
    if backend == "hf":
        if HF.state != "ready":
            raise RuntimeError("no HuggingFace model loaded")
        out = "".join(_hf_stream(messages, max_tokens, 0.3))
    else:
        payload = {"model": model, "messages": messages, "stream": False,
                   "options": {"temperature": 0.3, "num_predict": max_tokens,
                               "num_ctx": max(int(num_ctx or 8192), 2048)}}
        with httpx.Client(timeout=300) as client:
            r = client.post(f"{OLLAMA}/api/chat", json=payload)
            if r.status_code != 200:
                raise RuntimeError(f"ollama HTTP {r.status_code}: {r.text[:200]}")
            data = r.json()
            if data.get("error"):
                raise RuntimeError(data["error"])
            out = (data.get("message") or {}).get("content", "")
    # some reasoning templates leak chain-of-thought into content
    return re.sub(r"<think>.*?</think>", "", out, flags=re.S).strip()


@app.post("/api/memory/summarize")
def memory_summarize(req: MemSummarizeReq):
    """(Re)write a chat's briefing. Called on exit (best-effort sendBeacon --
    the desktop window hard-exits, so it can miss) and lazily on resume when
    the stored briefing is stale. Incremental: an existing briefing is updated
    from the new messages only, never regenerated from the full transcript."""
    chat = _mem_read(req.id)
    if not chat:
        return {"ok": False, "error": "no such chat"}
    n = len(chat.get("messages", []))
    prev = (chat.get("summary") or "").strip()
    upto = int(chat.get("summary_upto") or 0) if prev else 0
    if prev and upto >= n:
        return {"ok": True, "summary": prev, "fresh": True}
    if prev:
        user = ("PREVIOUS BRIEFING:\n" + prev
                + "\n\nNEW MESSAGES SINCE THAT BRIEFING:\n"
                + _mem_transcript(chat["messages"][upto:])
                + "\n\nRewrite the briefing to cover everything, old and new.")
    else:
        user = ("CONVERSATION:\n" + _mem_transcript(chat["messages"])
                + "\n\nWrite the briefing.")
    try:
        out = _gen_once(req.backend, req.model,
                        [{"role": "system", "content": _SUMMARY_SYS},
                         {"role": "user", "content": user}], num_ctx=req.num_ctx)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    if not out:
        return {"ok": False, "error": "model returned an empty summary"}
    with _MEM_LOCK:
        chat = _mem_read(req.id)
        if not chat:
            return {"ok": False, "error": "chat deleted mid-summary"}
        chat["summary"], chat["summary_upto"] = out[:4000], n
        _mem_write(chat)
    return {"ok": True, "summary": out}


# ---------------------------------------------------------------------------
# Document RAG (optional install, requirements-rag.txt): PDF/TXT/MD/DOCX files
# uploaded from the MEMORY drawer are chunked and embedded LOCALLY
# (sentence-transformers, CPU -- never competes with the LLM for VRAM) and
# searched per chat message; matching excerpts ride along as system context.
# Mirrors the Whisper stance: the embedding model downloads once, then
# nothing ever leaves the machine. Uploading is the opt-in act -- the server
# never indexes anything on its own, and retrieval only happens on an
# explicit /api/docs/search from the frontend.
#
# Layout: memory/docs/docs.json          [{id, name, ext, bytes, status, ...}]
#         memory/docs/files/<id><ext>    the original upload
#         memory/docs/chunks/<id>.json   [{text, label}]  (label = page range)
#         memory/docs/vectors/<id>.npy   float32 [n_chunks x dim], L2-normed
# The per-doc .npy files ARE the persisted vector store; the in-memory FAISS
# index (numpy dot-product fallback) is rebuilt from them lazily and
# invalidated on any add/delete, so deleting a doc never needs index surgery.
# ---------------------------------------------------------------------------

DOCS_DIR = os.path.join(MEM_DIR, "docs")
DOCS_FILES_DIR = os.path.join(DOCS_DIR, "files")
DOCS_CHUNKS_DIR = os.path.join(DOCS_DIR, "chunks")
DOCS_VECS_DIR = os.path.join(DOCS_DIR, "vectors")
DOCS_META_FILE = os.path.join(DOCS_DIR, "docs.json")
DOC_EXTS = {".pdf", ".txt", ".md", ".docx"}
DOC_MAX_BYTES = 100 * 1024 * 1024
EMBED_MODEL = os.environ.get("AEYE_EMBED_MODEL",
                             "sentence-transformers/all-MiniLM-L6-v2")
# cosine floor below which a chunk is dropped rather than injected -- weak
# matches actively mislead small models, so no context beats bad context
RAG_MIN_SCORE = float(os.environ.get("AEYE_RAG_MIN_SCORE", "0.30"))

_DOCS_LOCK = threading.Lock()      # docs.json + progress map + search cache
_DOC_PROGRESS: dict = {}           # id -> {stage, done, total} while indexing
_DOC_ACTIVE: set = set()           # ids with a worker this process (no requeues)
_RAG_DEPS: dict = {}


def _dep(name: str) -> bool:
    """Memoized import probe -- /api/docs/list polls once a second while the
    drawer is open, so don't pay a failed-import walk every time."""
    if name not in _RAG_DEPS:
        try:
            __import__(name)
            _RAG_DEPS[name] = True
        except Exception:
            _RAG_DEPS[name] = False
    return _RAG_DEPS[name]


def rag_available() -> bool:
    return _dep("sentence_transformers")


class _EmbedState:
    def __init__(self):
        self.lock = threading.Lock()
        self.model = None
        self.state = "idle"        # idle | loading | ready | error
        self.error: Optional[str] = None


EMBED = _EmbedState()
# SentenceTransformer.encode isn't guaranteed concurrency-safe on one model
# and indexing + a live search can overlap -- serialize inference.
_EMBED_INFER = threading.Lock()


def _embed_load():
    """Lazily load (and, first time, download ~90 MB) the embedding model.
    Concurrent callers share the one instance."""
    with EMBED.lock:
        if EMBED.model is not None:
            return EMBED.model
        busy = EMBED.state == "loading"
        if not busy:
            EMBED.state, EMBED.error = "loading", None
    if busy:                                # another thread is loading it
        for _ in range(1800):               # first run downloads -- allow ~3 min
            time.sleep(0.1)
            with EMBED.lock:
                if EMBED.model is not None:
                    return EMBED.model
                if EMBED.state == "error":
                    raise RuntimeError(EMBED.error or "embedding model failed")
        raise RuntimeError("embedding model load timed out")
    try:
        from sentence_transformers import SentenceTransformer
        m = SentenceTransformer(EMBED_MODEL, device="cpu")
        with EMBED.lock:
            EMBED.model, EMBED.state = m, "ready"
        return m
    except Exception as e:
        with EMBED.lock:
            EMBED.state, EMBED.error = "error", f"{type(e).__name__}: {e}"
        raise


# ---- doc metadata / chunk / vector files ----------------------------------

def _docs_read() -> list:
    try:
        with open(DOCS_META_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _docs_write(docs: list) -> None:
    os.makedirs(DOCS_DIR, exist_ok=True)
    tmp = DOCS_META_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(docs, f, ensure_ascii=False)
    os.replace(tmp, DOCS_META_FILE)


def _doc_get(docs: list, did: str) -> Optional[dict]:
    return next((d for d in docs if d["id"] == did), None)


def _doc_chunks_read(did: str) -> list:
    try:
        with open(os.path.join(DOCS_CHUNKS_DIR, did + ".json"),
                  encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _doc_files(doc: Optional[dict], did: str) -> list:
    paths = [os.path.join(DOCS_CHUNKS_DIR, did + ".json"),
             os.path.join(DOCS_VECS_DIR, did + ".npy")]
    if doc:
        paths.append(os.path.join(DOCS_FILES_DIR, did + doc["ext"]))
    return paths


# ---- extraction ------------------------------------------------------------

def _extract_units(path: str, ext: str) -> list:
    """-> [(label, text)] units; label is a page tag ('p3') for PDFs so
    excerpts can cite where they came from, None otherwise."""
    if ext == ".pdf":
        from pypdf import PdfReader
        units = []
        for i, page in enumerate(PdfReader(path).pages, 1):
            t = (page.extract_text() or "").strip()
            if t:
                units.append((f"p{i}", t))
        return units
    if ext == ".docx":
        # stdlib-only: a .docx is a zip; paragraph text lives in <w:t> runs
        import html as _html
        import zipfile
        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
        xml = re.sub(r"</w:p>", "\n\n", xml)
        xml = re.sub(r"<w:(?:tab|br)[^>]*/?>", " ", xml)
        return [(None, _html.unescape(re.sub(r"<[^>]+>", "", xml)))]
    with open(path, "rb") as f:                    # .txt / .md
        return [(None, f.read().decode("utf-8", "replace"))]


# ---- chunking ---------------------------------------------------------------
# Token counts are estimated at ~4 chars/token (blunt but model-agnostic).
# Chunks flush at ~800 est. tokens and pieces are capped at ~200, so chunks
# land in the requested 500-1000 token band (only a doc's final remainder
# can be shorter).

_CHUNK_TARGET = 800 * 4        # chars: flush the buffer past this point
_PIECE_MAX = 200 * 4           # chars: largest indivisible piece
_CHUNK_OVERLAP = 100 * 4       # chars carried into the next chunk


def _split_pieces(text: str) -> list:
    """Paragraphs, oversize paragraphs into sentences, oversize sentences by
    hard cuts -- so accumulation can stop close to the target."""
    pieces = []
    for para in re.split(r"\n\s*\n", text):
        para = para.strip()
        if not para:
            continue
        if len(para) <= _PIECE_MAX:
            pieces.append(para)
            continue
        for sent in re.split(r"(?<=[.!?])\s+", para):
            sent = sent.strip()
            while len(sent) > _PIECE_MAX:
                pieces.append(sent[:_PIECE_MAX])
                sent = sent[_PIECE_MAX:].strip()
            if sent:
                pieces.append(sent)
    return pieces


def _chunk_units(units: list) -> list:
    chunks = []
    buf, labs, fresh = "", [], False   # fresh = buf holds more than overlap

    def flush():
        nonlocal buf, labs, fresh
        text = buf.strip()
        if text and fresh:
            if labs:
                lab = labs[0] if labs[0] == labs[-1] else labs[0] + "-" + labs[-1]
            else:
                lab = ""
            chunks.append({"text": text, "label": lab})
        # seed the next chunk with this one's tail so an idea that straddles
        # the boundary is retrievable from either side
        tail = text[-_CHUNK_OVERLAP:]
        cut = tail.find(" ")
        buf = tail[cut + 1:] if 0 <= cut < len(tail) - 1 else tail
        labs = labs[-1:]
        fresh = False

    for label, text in units:
        for piece in _split_pieces(text):
            if label and (not labs or labs[-1] != label):
                labs.append(label)
            buf = (buf + "\n\n" + piece) if buf else piece
            fresh = True
            if len(buf) >= _CHUNK_TARGET:
                flush()
    flush()                            # remainder (skipped if only overlap)
    return chunks


# ---- indexing (background thread per upload) --------------------------------

def _doc_prog(did: str, stage: str, done: int = 0, total: int = 0) -> None:
    with _DOCS_LOCK:
        _DOC_PROGRESS[did] = {"stage": stage, "done": done, "total": total}


def _doc_fail(did: str, msg: str) -> None:
    with _DOCS_LOCK:
        docs = _docs_read()
        d = _doc_get(docs, did)
        if d:
            d["status"], d["error"] = "error", msg[:300]
            _docs_write(docs)
        _DOC_PROGRESS.pop(did, None)


def _doc_index(did: str) -> None:
    """Extract -> chunk -> embed -> persist. Runs in a daemon thread so huge
    PDFs never block the event loop; /api/docs/list reports the progress."""
    try:
        with _DOCS_LOCK:
            docs = _docs_read()
            d = _doc_get(docs, did)
            if not d:
                return
            d["status"], d["error"] = "indexing", None
            _docs_write(docs)
        path = os.path.join(DOCS_FILES_DIR, did + d["ext"])

        _doc_prog(did, "extracting")
        units = _extract_units(path, d["ext"])
        if not sum(len(t) for _, t in units):
            _doc_fail(did, "no extractable text (scanned/image PDF? no OCR here)")
            return

        _doc_prog(did, "chunking")
        chunks = _chunk_units(units)
        if not chunks:
            _doc_fail(did, "nothing to index")
            return
        os.makedirs(DOCS_CHUNKS_DIR, exist_ok=True)
        ctmp = os.path.join(DOCS_CHUNKS_DIR, did + ".json.tmp")
        with open(ctmp, "w", encoding="utf-8") as f:
            json.dump(chunks, f, ensure_ascii=False)
        os.replace(ctmp, os.path.join(DOCS_CHUNKS_DIR, did + ".json"))

        import numpy as np
        model = _embed_load()
        _doc_prog(did, "embedding", 0, len(chunks))
        mats = []
        for i in range(0, len(chunks), 16):
            batch = [c["text"] for c in chunks[i:i + 16]]
            with _EMBED_INFER:
                v = model.encode(batch, normalize_embeddings=True,
                                 show_progress_bar=False)
            mats.append(np.asarray(v, dtype="float32"))
            _doc_prog(did, "embedding", min(i + 16, len(chunks)), len(chunks))
        mat = np.concatenate(mats, axis=0)
        os.makedirs(DOCS_VECS_DIR, exist_ok=True)
        vtmp = os.path.join(DOCS_VECS_DIR, did + ".tmp.npy")
        np.save(vtmp, mat)
        os.replace(vtmp, os.path.join(DOCS_VECS_DIR, did + ".npy"))

        with _DOCS_LOCK:
            docs = _docs_read()
            d = _doc_get(docs, did)
            deleted = d is None            # user deleted it mid-index
            if d:
                d["status"], d["chunks"], d["error"] = "ready", len(chunks), None
                _docs_write(docs)
            _DOC_PROGRESS.pop(did, None)
            _SEARCH_CACHE["key"] = None
        if deleted:
            for p in _doc_files(None, did):
                try:
                    os.remove(p)
                except OSError:
                    pass
    except Exception as e:
        _doc_fail(did, f"{type(e).__name__}: {e}")


# ---- search -----------------------------------------------------------------

_SEARCH_CACHE: dict = {"key": None, "mat": None, "rows": None, "index": None}


def _search_matrix():
    """(matrix, row->(doc,chunk) map, faiss index or None) over every ready
    doc; cached until the doc set changes."""
    import numpy as np
    docs = [d for d in _docs_read() if d.get("status") == "ready"]
    key = tuple(sorted((d["id"], d.get("chunks", 0)) for d in docs))
    with _DOCS_LOCK:
        if _SEARCH_CACHE["key"] == key:
            return (_SEARCH_CACHE["mat"], _SEARCH_CACHE["rows"],
                    _SEARCH_CACHE["index"])
    mats, rows = [], []
    for d in docs:
        try:
            m = np.load(os.path.join(DOCS_VECS_DIR, d["id"] + ".npy"))
        except Exception:
            continue
        mats.append(m)
        rows.extend((d["id"], i) for i in range(m.shape[0]))
    mat = np.concatenate(mats, axis=0) if mats else None
    index = None
    if mat is not None and _dep("faiss"):
        import faiss
        index = faiss.IndexFlatIP(mat.shape[1])
        index.add(mat)
    with _DOCS_LOCK:
        _SEARCH_CACHE.update(key=key, mat=mat, rows=rows, index=index)
    return mat, rows, index


def _docs_do_search(q: str, k: int, min_score: Optional[float]) -> dict:
    import numpy as np
    mat, rows, index = _search_matrix()
    if mat is None or not rows:
        return {"ok": True, "results": []}
    model = _embed_load()
    with _EMBED_INFER:
        qv = np.asarray(model.encode([q], normalize_embeddings=True,
                                     show_progress_bar=False), dtype="float32")
    k = max(1, min(int(k or 4), 12))
    floor = RAG_MIN_SCORE if min_score is None else float(min_score)
    if index is not None:
        scores, ids = index.search(qv, min(k, len(rows)))
        pairs = [(float(s), int(i)) for s, i in zip(scores[0], ids[0]) if i >= 0]
    else:
        sims = mat @ qv[0]
        pairs = [(float(sims[i]), int(i)) for i in np.argsort(-sims)[:k]]
    names = {d["id"]: d["name"] for d in _docs_read()}
    by_doc, results = {}, []
    for score, row in pairs:
        if score < floor:                # relevance threshold
            continue
        did, ci = rows[row]
        if did not in by_doc:
            by_doc[did] = _doc_chunks_read(did)
        if did not in names or ci >= len(by_doc[did]):
            continue
        c = by_doc[did][ci]
        results.append({"doc_id": did, "name": names[did], "chunk": ci,
                        "label": c.get("label") or "",
                        "score": round(score, 3), "text": c["text"]})
    return {"ok": True, "results": results, "floor": floor}


# ---- endpoints --------------------------------------------------------------

class DocSearchReq(BaseModel):
    q: str
    k: int = 4
    min_score: Optional[float] = None    # override the server's cosine floor


@app.get("/api/docs/list")
def docs_list():
    docs = _docs_read()
    avail = rag_available()
    with _DOCS_LOCK:
        for d in docs:
            p = _DOC_PROGRESS.get(d["id"])
            if p:
                d["progress"] = dict(p)
            elif (avail and d.get("status") in ("queued", "indexing")
                    and d["id"] not in _DOC_ACTIVE):
                # a previous run died mid-index -- pick it back up (once)
                _DOC_ACTIVE.add(d["id"])
                threading.Thread(target=_doc_index, args=(d["id"],),
                                 daemon=True).start()
                d["progress"] = {"stage": "queued", "done": 0, "total": 0}
    with EMBED.lock:
        emb = {"state": EMBED.state, "error": EMBED.error}
    return {"docs": docs, "available": avail, "faiss": _dep("faiss"),
            "pdf": _dep("pypdf"), "model": EMBED_MODEL,
            "embed": emb, "min_score": RAG_MIN_SCORE}


@app.post("/api/docs/upload")
async def docs_upload(request: Request, name: str = ""):
    """Raw-body upload (?name=<filename>) -- no multipart, no extra dep,
    same shape as /api/stt. Saves the file, queues a background index."""
    if not rag_available():
        return {"ok": False, "error":
                f"document memory (RAG) not installed -- {_extras_hint()}"}
    base = os.path.basename((name or "").strip())
    ext = os.path.splitext(base)[1].lower()
    if ext not in DOC_EXTS:
        return {"ok": False,
                "error": f"unsupported type '{ext or '?'}' -- PDF, TXT, MD or DOCX"}
    if ext == ".pdf" and not _dep("pypdf"):
        return {"ok": False, "error": f"pypdf missing -- {_extras_hint()}"}
    data = await request.body()
    if not data:
        return {"ok": False, "error": "empty upload"}
    if len(data) > DOC_MAX_BYTES:
        return {"ok": False, "error": "file too large (100 MB cap)"}
    did = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    os.makedirs(DOCS_FILES_DIR, exist_ok=True)
    with open(os.path.join(DOCS_FILES_DIR, did + ext), "wb") as f:
        f.write(data)
    doc = {"id": did, "name": base[:120], "ext": ext, "bytes": len(data),
           "uploaded": time.time(), "status": "queued", "chunks": 0,
           "error": None}
    with _DOCS_LOCK:
        docs = _docs_read()
        docs.append(doc)
        _docs_write(docs)
        _DOC_ACTIVE.add(did)
        _DOC_PROGRESS[did] = {"stage": "queued", "done": 0, "total": 0}
    threading.Thread(target=_doc_index, args=(did,), daemon=True).start()
    return {"ok": True, "doc": doc}


@app.post("/api/docs/delete")
def docs_delete(req: MemIdReq):
    if not _MEM_ID_RE.match(req.id or ""):
        return {"ok": False, "error": "bad id"}
    with _DOCS_LOCK:
        docs = _docs_read()
        d = _doc_get(docs, req.id)
        _docs_write([x for x in docs if x["id"] != req.id])
        _DOC_PROGRESS.pop(req.id, None)
        _SEARCH_CACHE["key"] = None
    for p in _doc_files(d, req.id):
        try:
            os.remove(p)      # a mid-index worker may hold one open; it
        except OSError:       # cleans up after itself when it notices
            pass
    return {"ok": True}


@app.post("/api/docs/search")
async def docs_search(req: DocSearchReq):
    if not rag_available():
        return {"ok": False, "error": "document memory not installed"}
    q = (req.q or "").strip()
    if not q:
        return {"ok": True, "results": []}
    # embedding is blocking (and may load the model) -- off the event loop
    try:
        return await asyncio.to_thread(_docs_do_search, q, req.k, req.min_score)
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# --------------------------------------------------------------------------
# Web access (OPT-IN, OFF by default): a web_search tool + a fetch_url tool the
# chat model can invoke to reach CURRENT information. This is deliberate network
# EGRESS and breaks AEYE's default offline / no-telemetry posture, so the whole
# feature is gated behind the frontend toggle (localStorage 'aeye-web'): while
# off, web.js injects no tool instruction and never calls these endpoints, so
# the machine stays exactly as offline as before. While on, egress happens ONLY
# for the query/URL the model emits -- no background calls, no query logging.
#
# Provider: keyless DuckDuckGo by default (httpx + a stdlib HTML parse -- no new
# hard dep). If a Tavily / Brave / SerpAPI key is present (env or web_keys.txt,
# mirroring _hf_token()), it is preferred for higher-quality results.
#
# These are network READS only. Unlike plugins there is NO local command exec,
# which is exactly why a web tool may fire from model output while a plugin may
# not. fetch_url still passes through _web_safe_url() (SSRF guard) so the model
# can't make the server probe localhost / private hosts (the Ollama port, cloud
# metadata endpoints, the LAN). Untrusted page text is returned to the client
# tagged so it re-enters the model as external data, not instructions.
# --------------------------------------------------------------------------

import ipaddress as _ipaddress
import socket as _socket
from html.parser import HTMLParser as _HTMLParser
from urllib.parse import urlparse as _urlparse, parse_qs as _parse_qs, unquote as _unquote, quote as _quote

WEB_KEYS_FILE = paths.WEB_KEYS_FILE
_WEB_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Chrome/122.0 Safari/537.36")
_WEB_DEEP_MAX = 5      # top search hits auto-read (in parallel) per search


def _web_keys_file() -> dict:
    """Parse web_keys.txt: 'PROVIDER=key' (or ':' / whitespace) lines, '#'
    comments ignored. Best-effort -- absence just means keyless."""
    out = {}
    try:
        with open(WEB_KEYS_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                m = re.match(r"([A-Za-z_]+)\s*[=:\s]\s*(\S+)", line)
                if m:
                    out[m.group(1).upper()] = m.group(2)
    except Exception:
        pass
    return out


def _web_key(provider: str) -> Optional[str]:
    """API key for a search provider from env or web_keys.txt. Never required --
    keyless DuckDuckGo is the default. Mirrors _hf_token()."""
    env = {"tavily": "TAVILY_API_KEY", "brave": "BRAVE_API_KEY",
           "serpapi": "SERPAPI_API_KEY"}.get(provider)
    if not env:
        return None
    return os.environ.get(env) or _web_keys_file().get(env)


def _web_provider() -> str:
    """First key-bearing provider wins (Tavily > Brave > SerpAPI); else the
    keyless DuckDuckGo scraper."""
    for p in ("tavily", "brave", "serpapi"):
        if _web_key(p):
            return p
    return "ddg"


def _web_safe_url(url: str) -> str:
    """Validate a URL for fetch_url. Requires http/https and a PUBLIC host --
    every address the host resolves to must be public, else it's rejected. This
    is the SSRF guard: it stops the model asking the server to probe localhost
    or internal services. Returns the URL or raises ValueError."""
    u = _urlparse((url or "").strip())
    if u.scheme not in ("http", "https"):
        raise ValueError("only http/https URLs are allowed")
    host = u.hostname
    if not host:
        raise ValueError("no host in URL")
    try:
        infos = _socket.getaddrinfo(host, None)
    except Exception:
        raise ValueError(f"cannot resolve host: {host}")
    for info in infos:
        ip = info[4][0]
        try:
            addr = _ipaddress.ip_address(ip)
        except ValueError:
            raise ValueError(f"bad address: {ip}")
        if (addr.is_loopback or addr.is_private or addr.is_link_local
                or addr.is_reserved or addr.is_multicast or addr.is_unspecified):
            raise ValueError(f"blocked non-public host: {host} ({ip})")
    return url


class _TextExtractor(_HTMLParser):
    """Minimal readable-text extractor: drops script/style/nav/etc., keeps text,
    records <title>. The stdlib fallback for when trafilatura isn't installed."""
    _SKIP = {"script", "style", "noscript", "template", "svg", "head",
             "nav", "footer", "header", "aside", "form"}
    _BLOCK = {"p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5",
              "h6", "section", "article", "pre", "blockquote"}

    def __init__(self):
        super().__init__()
        self.parts = []
        self.title = ""
        self._skip = 0
        self._in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip += 1
        if tag == "title":
            self._in_title = True
        if tag in self._BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip:
            self._skip -= 1
        if tag == "title":
            self._in_title = False
        if tag in self._BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._skip:
            return
        if data.strip():
            self.parts.append(data)

    def text(self) -> str:
        lines = [re.sub(r"[ \t]+", " ", ln).strip()
                 for ln in "".join(self.parts).splitlines()]
        out, blank = [], 0
        for ln in lines:
            if ln:
                out.append(ln)
                blank = 0
            elif blank == 0:          # collapse runs of blank lines to one
                out.append("")
                blank = 1
        return "\n".join(out).strip()


def _web_extract(html_text: str, cap: int = 12000):
    """(title, text). Prefer trafilatura (optional install); fall back to the
    stdlib extractor. Text is capped so one page can't blow the context."""
    title, text = "", ""
    try:
        import trafilatura
        text = trafilatura.extract(html_text, include_comments=False,
                                   include_tables=False) or ""
        try:
            meta = trafilatura.extract_metadata(html_text)
            title = (getattr(meta, "title", "") or "") if meta else ""
        except Exception:
            title = ""
    except Exception:
        text = ""
    if not text:
        p = _TextExtractor()
        try:
            p.feed(html_text)
        except Exception:
            pass
        text = p.text()
        title = title or p.title.strip()
    if len(text) > cap:
        text = text[:cap].rstrip() + "\n… [truncated]"
    return title.strip(), text


def _web_rank(text: str, query: str, budget: int = 9000):
    """(ranked_text, ranked?). Distil a long page down to the slices most
    relevant to `query` -- the user's actual question -- so the answer isn't
    buried past a blind truncation. Reuses the docs RAG embedder (same chunker
    + model), and degrades to a head slice when RAG isn't installed or anything
    fails, so fetch always returns SOMETHING."""
    head = text[:budget]
    if not query or not rag_available() or len(text) <= budget:
        return head, False
    try:
        import numpy as np
        chunks = [c["text"] for c in _chunk_units([("", text)])]
        if len(chunks) <= 1:
            return head, False
        model = _embed_load()
        with _EMBED_INFER:            # serialize with docs indexing/search
            embs = np.asarray(model.encode(chunks, normalize_embeddings=True,
                                           show_progress_bar=False), dtype="float32")
            qv = np.asarray(model.encode([query], normalize_embeddings=True,
                                         show_progress_bar=False), dtype="float32")
        sims = embs @ qv[0]
        picked, total = [], 0
        for i in np.argsort(-sims):            # best-scoring chunks first
            t = chunks[int(i)]
            if picked and total + len(t) > budget:
                break
            picked.append(int(i))
            total += len(t)
        picked.sort()                          # re-read in document order
        return "\n\n[…]\n\n".join(chunks[i] for i in picked), True
    except Exception:
        return head, False


class _DDGParser(_HTMLParser):
    """Scrape result rows from html.duckduckgo.com/html/: the result anchor
    (class result__a) gives href+title, result__snippet gives the summary."""
    def __init__(self):
        super().__init__()
        self.results = []
        self._cur = None
        self._grab = None            # 'title' | 'snippet' | None

    def commit(self):
        if self._cur and self._cur.get("url"):
            self.results.append(self._cur)
        self._cur = None
        self._grab = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class", "") or ""
        if tag == "a" and "result__a" in cls:
            self.commit()
            self._cur = {"url": a.get("href", ""), "title": "", "snippet": ""}
            self._grab = "title"
        elif "result__snippet" in cls and self._cur is not None:
            self._grab = "snippet"

    def handle_endtag(self, tag):
        if tag == "a" and self._grab == "title":
            self._grab = None
        elif tag in ("a", "div") and self._grab == "snippet":
            self._grab = None

    def handle_data(self, data):
        if self._grab and self._cur is not None:
            self._cur[self._grab] += data


def _ddg_unwrap(href: str) -> str:
    """DDG wraps result links as //duckduckgo.com/l/?uddg=<encoded>. Decode back
    to the real destination URL."""
    if not href:
        return href
    if href.startswith("//"):
        href = "https:" + href
    try:
        u = _urlparse(href)
        if "duckduckgo.com" in (u.netloc or "") and u.path.startswith("/l/"):
            q = _parse_qs(u.query)
            if q.get("uddg"):
                return _unquote(q["uddg"][0])
    except Exception:
        pass
    return href


def _clean(s: str) -> str:
    return re.sub(r"\s+", " ", s or "").strip()


# recency window -> each provider's own "freshness" parameter value. Lets a
# "latest/today/news" query ask the engine for only recent pages, so the model
# stops mixing years-old results in with current ones.
_RECENCY = {
    "ddg":     {"day": "d",  "week": "w",  "month": "m",  "year": "y"},
    "brave":   {"day": "pd", "week": "pw", "month": "pm", "year": "py"},
    "serpapi": {"day": "qdr:d", "week": "qdr:w", "month": "qdr:m", "year": "qdr:y"},
    "tavily":  {"day": "day", "week": "week", "month": "month", "year": "year"},
}


def _recency_param(recency: Optional[str], style: str) -> Optional[str]:
    if recency not in ("day", "week", "month", "year"):
        return None
    return _RECENCY[style].get(recency)


async def _ddg_search(query: str, k: int, recency: Optional[str] = None) -> list:
    data = {"q": query}
    df = _recency_param(recency, "ddg")
    if df:
        data["df"] = df
    async with httpx.AsyncClient(timeout=15, follow_redirects=True,
                                 headers={"User-Agent": _WEB_UA}) as client:
        r = await client.post("https://html.duckduckgo.com/html/", data=data)
        r.raise_for_status()
        p = _DDGParser()
        p.feed(r.text)
        p.commit()
    out = []
    for res in p.results[:k]:
        url = _ddg_unwrap(res["url"])
        if url:
            out.append({"title": _clean(res["title"]), "url": url,
                        "snippet": _clean(res["snippet"])})
    return out


async def _tavily_search(query: str, k: int, key: str,
                         recency: Optional[str] = None) -> list:
    body = {"api_key": key, "query": query, "max_results": k}
    tr = _recency_param(recency, "tavily")
    if tr:
        body["time_range"] = tr
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post("https://api.tavily.com/search", json=body)
        r.raise_for_status()
        data = r.json()
    return [{"title": _clean(x.get("title", "")), "url": x.get("url", ""),
             "snippet": _clean(x.get("content", ""))}
            for x in (data.get("results") or [])[:k]]


async def _brave_search(query: str, k: int, key: str,
                        recency: Optional[str] = None) -> list:
    params = {"q": query, "count": k}
    fr = _recency_param(recency, "brave")
    if fr:
        params["freshness"] = fr
    async with httpx.AsyncClient(timeout=15,
                                 headers={"X-Subscription-Token": key,
                                          "Accept": "application/json"}) as client:
        r = await client.get("https://api.search.brave.com/res/v1/web/search",
                             params=params)
        r.raise_for_status()
        data = r.json()
    return [{"title": _clean(x.get("title", "")), "url": x.get("url", ""),
             "snippet": _clean(x.get("description", ""))}
            for x in ((data.get("web") or {}).get("results") or [])[:k]]


async def _serpapi_search(query: str, k: int, key: str,
                          recency: Optional[str] = None) -> list:
    params = {"engine": "google", "q": query, "api_key": key, "num": k}
    tbs = _recency_param(recency, "serpapi")
    if tbs:
        params["tbs"] = tbs
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get("https://serpapi.com/search", params=params)
        r.raise_for_status()
        data = r.json()
    return [{"title": _clean(x.get("title", "")), "url": x.get("link", ""),
             "snippet": _clean(x.get("snippet", ""))}
            for x in (data.get("organic_results") or [])[:k]]


class WebSearchReq(BaseModel):
    query: str
    k: int = 5
    deep: bool = True                 # auto-fetch the top result's full page
    recency: Optional[str] = None     # day|week|month|year -> freshness filter


class WebFetchReq(BaseModel):
    url: str
    query: Optional[str] = None       # user's question -> relevance-ranked slices


@app.get("/api/web/info")
def web_info():
    prov = _web_provider()
    return {"available": True, "provider": prov, "has_key": prov != "ddg"}


@app.post("/api/web/search")
async def web_search(req: WebSearchReq):
    query = (req.query or "").strip()
    if not query:
        return {"ok": False, "error": "empty query"}
    k = max(1, min(int(req.k or 5), 10))
    prov = _web_provider()
    try:
        rec = req.recency
        if prov == "tavily":
            results = await _tavily_search(query, k, _web_key("tavily"), rec)
        elif prov == "brave":
            results = await _brave_search(query, k, _web_key("brave"), rec)
        elif prov == "serpapi":
            results = await _serpapi_search(query, k, _web_key("serpapi"), rec)
        else:
            results = await _ddg_search(query, k, rec)
    except Exception as e:
        return {"ok": False, "provider": prov, "results": [],
                "error": f"{type(e).__name__}: {e}"}

    # auto-fetch the top few hits IN PARALLEL so one search gathers data from
    # SEVERAL sources at once (not just the first that loads); the model then
    # weighs them and concludes from what multiple sources agree on. Blocked
    # pages (403/timeout) simply drop out -- we keep whatever loaded, in rank
    # order. Per-page budget/extract caps are small so 5 pages stay light.
    top_pages = []
    if req.deep and results:
        cand = [r for r in results[:_WEB_DEEP_MAX] if r.get("url")]
        pages = await asyncio.gather(
            *(_web_fetch_page(r["url"], query, timeout=8, budget=2500,
                              extract_cap=25000) for r in cand),
            return_exceptions=True)
        for r, page in zip(cand, pages):
            if isinstance(page, dict) and page.get("ok") and page.get("text"):
                top_pages.append({"url": page["url"],
                                  "title": page.get("title") or r.get("title") or "",
                                  "text": page["text"],
                                  "ranked": page.get("ranked", False)})
    return {"ok": bool(results), "provider": prov, "results": results,
            "top_pages": top_pages, "error": None if results else "no results"}


async def _web_fetch_page(url: str, query: str, timeout: float = 15,
                          budget: int = 9000, extract_cap: int = 60000) -> dict:
    """Fetch + extract + relevance-rank one page. The shared core behind both
    the fetch_url endpoint and search's auto-fetch. Returns {ok, url, title,
    text, ranked} or {ok:False, error}; never raises. `extract_cap` bounds how
    much raw text is embedded for ranking -- kept small in the multi-page search
    path so reading 5 sources stays light on weak hardware."""
    url = (url or "").strip()
    try:
        _web_safe_url(url)
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    html_text, final = "", url
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False,
                                     headers={"User-Agent": _WEB_UA,
                                              "Accept": "text/html,*/*"}) as client:
            # follow redirects MANUALLY, re-validating each hop -- httpx's own
            # redirect following would connect to a blocked host before we could
            # check it (redirect-based SSRF).
            for _ in range(6):
                async with client.stream("GET", url) as r:
                    if r.status_code in (301, 302, 303, 307, 308):
                        loc = r.headers.get("location")
                        if not loc:
                            return {"ok": False, "error": "redirect without location"}
                        url = str(r.url.join(loc))
                        try:
                            _web_safe_url(url)
                        except ValueError as e:
                            return {"ok": False,
                                    "error": f"redirect to blocked host: {e}"}
                        continue
                    if r.status_code >= 400:
                        return {"ok": False, "error": f"HTTP {r.status_code}"}
                    ctype = r.headers.get("content-type", "")
                    if ctype and "html" not in ctype and "text" not in ctype:
                        return {"ok": False,
                                "error": f"unsupported content-type: {ctype}"}
                    chunks, total = [], 0
                    async for chunk in r.aiter_bytes():
                        chunks.append(chunk)
                        total += len(chunk)
                        if total > 2_000_000:      # ~2 MB cap
                            break
                    html_text = b"".join(chunks).decode("utf-8", errors="ignore")
                    final = str(r.url)
                    break
            else:
                return {"ok": False, "error": "too many redirects"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
    # extract generously, then let _web_rank distil the page to the part that
    # answers the query (falls back to a head slice without RAG)
    title, text = _web_extract(html_text, cap=extract_cap)
    if not text:
        return {"ok": False, "url": final, "error": "no readable text extracted"}
    text, ranked = await asyncio.to_thread(_web_rank, text, (query or "").strip(), budget)
    return {"ok": True, "url": final, "title": title, "text": text, "ranked": ranked}


@app.post("/api/web/fetch")
async def web_fetch(req: WebFetchReq):
    return await _web_fetch_page(req.url, (req.query or "").strip())


# ---- sidebar browser proxy ----------------------------------------------
# Fetches a page server-side (SSRF-guarded, re-validated on every redirect hop
# like fetch_url), strips X-Frame-Options / frame-ancestors so the sidebar
# <iframe> can embed it, drops ad/tracker <script>/<iframe> tags, and injects a
# <base> plus an OLED theme + cosmetic ad-hiding so the page matches the app.
# USER-DRIVEN only (fetches nothing but the URL the user navigates to; no
# background calls). Dynamic/JS-heavy sites degrade to a reader-grade view --
# the sidebar's external-open button hands those to the system browser.
_BROWSE_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
_BROWSE_AD_HOSTS = (
    "doubleclick.net", "googlesyndication.com", "adservice.google", "ads.youtube.com",
    "google-analytics.com", "googletagmanager.com", "adnxs.com", "taboola.com",
    "outbrain.com", "scorecardresearch.com", "amazon-adsystem.com", "adsafeprotected.com",
    "moatads.com", "criteo.", "pubmatic.com", "rubiconproject.com", "2mdn.net",
    "quantserve.com", "adroll.com", "casalemedia.com", "openx.net", "sharethrough.com",
)
_BROWSE_CSS = (
    '<style id="aeye-browse-theme">'
    "html,body{background:#000 !important;color:#00ff88 !important}"
    "body *{background-color:transparent !important;color:#00ff88 !important;"
    "border-color:#0a4020 !important;box-shadow:none !important;text-shadow:none !important}"
    "a,a *{color:#5cffb0 !important}"
    "img,video,picture,svg,canvas,iframe{background:#000 !important}"
    "input,textarea,select,button{background:#061a10 !important;color:#00ff88 !important}"
    '[id*="ad-" i],[id^="ad" i],[class*="advert" i],[class*="-ads" i],'
    '[class*="sponsor" i],ins.adsbygoogle,[id*="google_ads" i],'
    'iframe[src*="ads" i],iframe[src*="doubleclick" i],[class*="cookie" i],'
    '[class*="consent" i],[class*="paywall" i],[class*="newsletter" i],'
    '[class*="promo" i],[aria-label*="advert" i]{display:none !important}'
    # force a black + green scrollbar on every browsed page. scrollbar-color
    # (modern Chromium) forces it even over sites that style their own; the
    # ::-webkit rules are the fallback for older engines.
    "html{scrollbar-color:#0a4020 #000 !important;scrollbar-width:thin}"
    "::-webkit-scrollbar{width:11px;height:11px}"
    "::-webkit-scrollbar-track{background:#000 !important}"
    "::-webkit-scrollbar-thumb{background:#0a4020 !important;border-radius:5px}"
    "::-webkit-scrollbar-thumb:hover{background:#00ff88 !important}"
    "::-webkit-scrollbar-corner{background:#000 !important}"
    "</style>"
)
_BROWSE_JS = (
    '<script id="aeye-browse-clean">(function(){try{'
    "function c(){document.querySelectorAll('body *').forEach(function(el){"
    "var s=getComputedStyle(el);"
    "if((s.position==='fixed'||s.position==='sticky')&&el.offsetHeight>window.innerHeight*0.6)"
    "el.style.setProperty('display','none','important');});}"
    "if(document.readyState!=='loading')c();else addEventListener('DOMContentLoaded',c);"
    "setTimeout(c,1500);}catch(e){}})();</script>"
)


def _browse_strip_ads(body: str) -> str:
    def bad(src: str) -> bool:
        s = src.lower()
        return any(h in s for h in _BROWSE_AD_HOSTS)
    body = re.sub(r'<script\b[^>]*\bsrc=["\']([^"\']*)["\'][^>]*>\s*</script>',
                  lambda m: "" if bad(m.group(1)) else m.group(0), body, flags=re.I)
    body = re.sub(r'<iframe\b[^>]*\bsrc=["\']([^"\']*)["\'][^>]*>.*?</iframe>',
                  lambda m: "" if bad(m.group(1)) else m.group(0), body, flags=re.I | re.S)
    return body


async def _browse_fetch(url: str):
    """Follow redirects manually, re-running the SSRF guard on every hop."""
    async with httpx.AsyncClient(
            timeout=httpx.Timeout(15.0, connect=6.0), follow_redirects=False,
            headers={"User-Agent": _BROWSE_UA,
                     "Accept": "text/html,application/xhtml+xml,image/*,*/*;q=0.8",
                     "Accept-Language": "en-US,en;q=0.9"}) as client:
        cur = url
        for _ in range(6):
            _web_safe_url(cur)
            r = await client.get(cur)
            loc = r.headers.get("location")
            if r.status_code in (301, 302, 303, 307, 308) and loc:
                cur = str(httpx.URL(str(r.url)).join(loc))
                continue
            return cur, r
        return cur, r


def _browse_user_css(url: str) -> str:
    """Per-site (and global) user stylesheets injected into browsed pages, so a
    site can be themed exactly -- e.g. a custom 4chan theme. Files live in
    DATA_DIR/browser-css/<hostname>.css plus _all.css (editable by the user).
    Injected AFTER the built-in theme so the user's rules win."""
    try:
        host = (_urlparse(url).hostname or "").lower()
    except Exception:
        host = ""
    cdir = os.path.join(paths.DATA_DIR, "browser-css")
    parts = []
    for name in (host, "_all"):
        if not name:
            continue
        try:
            with open(os.path.join(cdir, name + ".css"), encoding="utf-8") as f:
                parts.append(f.read())
        except OSError:
            pass
    if not parts:
        return ""
    return '<style id="aeye-browse-user">' + "\n".join(parts) + "</style>"


@app.get("/api/browse")
async def api_browse(request: Request):
    raw = (request.query_params.get("url") or "").strip()
    try:
        _web_safe_url(raw)
    except Exception as e:
        return Response(f"blocked: {e}", status_code=400, media_type="text/plain")
    try:
        final, r = await _browse_fetch(raw)
    except Exception as e:
        return Response(f"could not load {raw}: {e}", status_code=502,
                        media_type="text/plain")
    ctype = (r.headers.get("content-type") or "").lower()
    # non-HTML (images/pdf/json/xml/...) -> pass through untouched, just no XFO
    if "html" not in ctype:
        return Response(
            r.content,
            media_type=r.headers.get("content-type") or "application/octet-stream",
            headers={"Cache-Control": "no-store"})
    body = _browse_strip_ads(r.text)
    inject = (f'<base href="{final.replace(chr(34), "%22")}">'
              '<meta name="referrer" content="no-referrer">'
              f"{_BROWSE_CSS}{_BROWSE_JS}{_browse_user_css(final)}")
    m = re.search(r"<head[^>]*>", body, re.I)
    body = body[:m.end()] + inject + body[m.end():] if m else inject + body
    # deliberately NO X-Frame-Options / frame-ancestors header -> embeddable
    return Response(body, media_type="text/html; charset=utf-8",
                    headers={"Cache-Control": "no-store", "X-AEYE-Browse": "1"})


# ---- price tickers -------------------------------------------------------
# Keyless quotes from Yahoo Finance's chart endpoint. The host is FIXED here
# (symbols are validated to a safe charset and only ever form the path, never
# the host), so there is no SSRF surface -- unlike fetch_url this can't be
# pointed at localhost/the LAN. ticker.js calls this ONLY while the web-access
# toggle is on, so it inherits web.js's opt-in gate: nothing here runs while
# the app is in its default fully-offline state.
_TICKER_HOST = "https://query1.finance.yahoo.com/v8/finance/chart/"
_TICKER_SYM_RE = re.compile(r"^[A-Za-z0-9.\-^=]{1,15}$")

# Crypto fallback: map our Yahoo-style crypto symbols to CoinGecko coin ids.
# When Yahoo drops a crypto quote (rate-limit / endpoint change), we refill it
# from CoinGecko's keyless simple-price API in ONE batched call. Fixed host, so
# no SSRF surface. Commodities/indices have no such free fallback -- they just
# drop out, and an all-empty lane reads "ticker offline" client-side.
_COINGECKO_IDS = {
    "BTC-USD": "bitcoin", "ETH-USD": "ethereum", "SOL-USD": "solana",
    "XRP-USD": "ripple", "DOGE-USD": "dogecoin", "BNB-USD": "binancecoin",
    "ADA-USD": "cardano",
}


async def _coingecko_quotes(client, syms) -> dict:
    """Batch-fetch the given crypto symbols from CoinGecko. Returns
    {symbol: quote} for whatever resolved; {} on any failure."""
    ids = {_COINGECKO_IDS[s]: s for s in syms if s in _COINGECKO_IDS}
    if not ids:
        return {}
    try:
        r = await client.get(
            "https://api.coingecko.com/api/v3/simple/price",
            params={"ids": ",".join(ids), "vs_currencies": "usd",
                    "include_24hr_change": "true"},
            headers={"User-Agent": _WEB_UA})
        if r.status_code != 200:
            return {}
        data = r.json() or {}
    except Exception:
        return {}
    out = {}
    for cid, sym in ids.items():
        row = data.get(cid) or {}
        price = row.get("usd")
        if price is None:
            continue
        price = float(price)
        pct = float(row.get("usd_24h_change") or 0.0)
        prev = price / (1.0 + pct / 100.0) if pct else price
        out[sym] = {"symbol": sym, "price": price, "change": price - prev,
                    "pct": pct, "currency": "USD"}
    return out


async def _ticker_quote(client, sym: str) -> Optional[dict]:
    """Latest price + change vs previous close for one symbol. Returns a dict
    or None on any failure (a bad symbol just drops out of the strip)."""
    try:
        r = await client.get(_TICKER_HOST + _quote(sym, safe=""),
                             params={"range": "1d", "interval": "1d"},
                             headers={"User-Agent": _WEB_UA})
        if r.status_code != 200:
            return None
        result = (((r.json() or {}).get("chart") or {}).get("result") or [])
        meta = (result[0].get("meta") if result else None) or {}
        price = meta.get("regularMarketPrice")
        if price is None:
            return None
        price = float(price)
        prev = meta.get("chartPreviousClose") or meta.get("previousClose")
        prev = float(prev) if prev else price
        change = price - prev
        return {"symbol": sym, "price": price, "change": change,
                "pct": (change / prev * 100.0) if prev else 0.0,
                "currency": meta.get("currency") or ""}
    except Exception:
        return None


@app.get("/api/ticker")
async def ticker(symbols: str = ""):
    syms, seen = [], set()
    for s in (symbols or "").split(","):
        s = s.strip()
        if s and s not in seen and _TICKER_SYM_RE.match(s):
            seen.add(s)
            syms.append(s)
        if len(syms) >= 20:
            break
    if not syms:
        return {"ok": False, "error": "no valid symbols", "quotes": []}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0, connect=4.0),
                                     follow_redirects=True) as client:
            got = await asyncio.gather(*(_ticker_quote(client, s) for s in syms))
            by = {q["symbol"]: q for q in got if q}
            # refill any crypto Yahoo dropped from CoinGecko (one batched call)
            missing = [s for s in syms if s not in by and s in _COINGECKO_IDS]
            if missing:
                by.update(await _coingecko_quotes(client, missing))
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}", "quotes": []}
    quotes = [by[s] for s in syms if s in by]      # keep the requested order
    return {"ok": bool(quotes), "quotes": quotes,
            "error": None if quotes else "no quotes"}


# --------------------------------------------------------------------------
# P2P (Phase 1): session codes + a TCP handshake listener + a UPnP stub.
# Fully modular under p2p/. The listener binds its OWN port (default 8131) and
# never touches the main HTTP server on 8130. Nothing runs until the user
# starts a session from the "encrypted p2p" window; stopping (or app exit)
# tears the listener + session down cleanly.
# --------------------------------------------------------------------------
_P2P_SESSIONS = p2p.SessionManager()
_p2p_listener = None                       # created on the first host-start
_p2p_lock = threading.Lock()

# TLS: keep the self-signed cert under the data dir, and pre-generate it in a
# background thread at startup so the first host-start doesn't pay the (one-time)
# key-generation cost. TLS is transport-only -- the protocol/chat are unchanged.
p2p.set_cert_dir(os.path.join(paths.DATA_DIR, "p2p"))


def _p2p_prewarm_tls():
    try:
        p2p.ensure_cert()
    except Exception:
        pass


threading.Thread(target=_p2p_prewarm_tls, name="p2p-tls-warm", daemon=True).start()


# --------------------------------------------------------------------------
# Board-ticker relay autostart. The relay (aeye-4chan-relay.py) MUST come up on
# every AEYE launch, unconditionally -- no battery/power gate (the old
# ONLOGON scheduled task inherited Windows' "only on AC power" default, which is
# the bug this replaces). We run it IN-PROCESS on a hidden daemon thread rather
# than the spec's literal subprocess.Popen(sys.executable, ...): under the frozen
# PyInstaller build sys.executable is AEYE.exe (not a Python), so a subprocess
# would relaunch the whole app. An in-process thread is windowless by nature,
# needs no external Python, works on every machine, and never blocks startup.
def _relay_path():
    """Locate aeye-4chan-relay.py across source + frozen layouts."""
    cands = [
        paths.resource("aeye-4chan-relay.py"),                 # source root / bundle
        os.path.join(os.path.dirname(sys.executable), "aeye-4chan-relay.py"),  # install root
        os.path.join(paths.DATA_DIR, "relay", "aeye-4chan-relay.py"),          # task location
    ]
    for p in cands:
        if p and os.path.isfile(p):
            return p
    return None


def start_relay():
    """Bring the local 4chan CORS relay up in-process (daemon, hidden,
    non-blocking). Silent on any failure -- the relay is best-effort; if the port
    is already bound (e.g. a leftover scheduled-task instance) that's fine, the
    relay is already serving."""
    try:
        import importlib.util
        from http.server import ThreadingHTTPServer
        rp = _relay_path()
        if not rp:
            return
        spec = importlib.util.spec_from_file_location("aeye_relay_mod", rp)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)                # defines Handler/HOST/PORT only
        host = getattr(mod, "HOST", "127.0.0.1")
        port = getattr(mod, "PORT", 8788)

        def _serve():
            try:
                srv = ThreadingHTTPServer((host, port), mod.Handler)
            except OSError:
                return                              # already bound -> relay is up
            except Exception:
                return
            try:
                srv.serve_forever()
            except Exception:
                pass

        threading.Thread(target=_serve, name="aeye-relay", daemon=True).start()
    except Exception:
        pass                                        # never let the relay break boot


start_relay()


# Best-effort UPnP NAT traversal at boot: map the P2P listener port so a peer can
# reach this instance over the internet. Runs on a background thread and fails
# silently (LAN-only) when miniupnpc is absent or the router has no UPnP/IGD.
# NOTE: we map the P2P port (p2p.DEFAULT_PORT, 8131), not 8130 -- 8130 is AEYE's
# local HTTP server and forwarding it would not help P2P connectivity.
try:
    p2p.upnp_autostart(p2p.DEFAULT_PORT)
except Exception:
    pass


def _lan_ip() -> str:
    """Best-effort LAN IP of this machine, for a peer to dial. Falls back to
    127.0.0.1. No packet is sent -- connect() on a UDP socket just picks the
    outbound interface."""
    import socket
    s = None
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        if s:
            try:
                s.close()
            except Exception:
                pass


class P2PHostReq(BaseModel):
    port: Optional[int] = None


class P2PConnectReq(BaseModel):
    ip: str
    port: int
    code: str


class P2PUpnpReq(BaseModel):
    port: Optional[int] = None
    enable: bool = True


@app.post("/api/p2p/host/start")
def p2p_host_start(req: P2PHostReq):
    """Host a session: mint a code and start the TCP listener. Returns the code
    plus the dial-in info (LAN IP + port) for a peer."""
    global _p2p_listener
    port = int(req.port) if req.port else p2p.DEFAULT_PORT
    with _p2p_lock:
        info = _P2P_SESSIONS.create_session()      # a fresh code each (re)start
        if _p2p_listener and _p2p_listener.is_running():
            _p2p_listener.stop()
        _p2p_listener = p2p.P2PListener(_P2P_SESSIONS, port=port)
        try:
            _p2p_listener.start()
        except OSError as e:
            _P2P_SESSIONS.invalidate_session()
            _p2p_listener = None
            # WinError 10013 -> firewall/VPN; otherwise report the bind error
            if isinstance(e, PermissionError) or "10013" in str(e):
                return {"ok": False, "error": _p2p_friendly_error(e)}
            return {"ok": False, "error": f"could not bind port {port}: {e}"}
    return {"ok": True, "code": info["code"], "ip": _lan_ip(), "port": port,
            "expires_in": info["expires_in"]}


@app.post("/api/p2p/host/stop")
def p2p_host_stop():
    """Stop hosting: close the listener and invalidate the session code."""
    with _p2p_lock:
        if _p2p_listener:
            _p2p_listener.stop()
        _P2P_SESSIONS.invalidate_session()
    return {"ok": True}


@app.get("/api/p2p/status")
def p2p_status():
    """Current host state -- used by the window to show the code, dial-in info,
    live connection count and the verbose listener log."""
    info = _P2P_SESSIONS.info()
    listener = _p2p_listener
    running = bool(listener and listener.is_running())
    return {
        "hosting": running,
        "code": info["code"] if running else None,
        "expires_in": info["expires_in"],
        "active": info["active"],
        "ip": _lan_ip() if running else None,
        "port": listener.port if running else p2p.DEFAULT_PORT,
        "connections": listener.conn_count() if running else 0,
        "logs": list(listener.logs) if listener else [],
    }


@app.post("/api/p2p/connect")
def p2p_connect(req: P2PConnectReq):
    """Client side: dial a host, send the auth code, return the handshake result.
    Nothing is kept open (Phase 1 has no chat yet)."""
    ip = (req.ip or "").strip()
    if not ip:
        return {"ok": False, "error": "missing IP"}
    res = p2p.connect_and_auth(ip, int(req.port), (req.code or "").strip())
    resp = res.get("response") or {}
    return {"ok": res["ok"], "result": resp.get("type"), "error": res.get("error")}


@app.post("/api/p2p/upnp")
def p2p_upnp(req: P2PUpnpReq):
    """Attempt (or remove) a UPnP port forward via miniupnpc. On failure the app
    stays in LAN-only mode and returns a truthful reason for the UI."""
    port = int(req.port) if req.port else (
        _p2p_listener.port if _p2p_listener else p2p.DEFAULT_PORT)
    ok = p2p.attempt_port_forward(port) if req.enable else p2p.remove_port_forward(port)
    note = None
    if not ok:
        if not p2p.upnp_available():
            note = "UPnP support not installed -- use the manual port-forwarding guide"
        else:
            # miniupnpc loaded fine; the router either has no IGD or UPnP is
            # switched off in its settings. Point the user there.
            note = ("UPnP couldn't map the port -- enable UPnP in your router's "
                    "settings, or use the manual port-forwarding guide")
    return {"ok": ok, "port": port, "note": note}


def _p2p_shutdown():
    try:
        if _p2p_listener:
            _p2p_listener.stop()
    except Exception:
        pass


import atexit as _atexit  # noqa: E402
_atexit.register(_p2p_shutdown)


# --------------------------------------------------------------------------
# P2P Phase 2: real-time chat over the authenticated connection. All ADDITIVE
# -- the Phase 1 auth/connection/route code above is untouched. A host chats
# with whichever peer authenticated to its listener; a client opens a
# PERSISTENT connection (new route -- the one-shot /api/p2p/connect stays as
# is) and both sides read/send NDJSON via p2p.HUB.
# --------------------------------------------------------------------------
_p2p_client_conn = None
_p2p_client_thread = None
_p2p_client_lock = threading.Lock()


def _p2p_client_log(line):
    try:
        print("P2P " + line, flush=True)
    except Exception:
        pass


_p2p_debug = False        # verbose logging incl. message contents (synced from UI)


def _p2p_friendly_error(e) -> str:
    """Map low-level socket errors to a clear, user-facing message. WinError
    10013 (an access-forbidden socket error) is almost always a firewall or VPN
    blocking the direct connection."""
    s = str(e)
    if isinstance(e, PermissionError) or "10013" in s:
        return ("Connection blocked (likely firewall or VPN). Try disabling VPN "
                "or allowing AEYE through the firewall.")
    return "{}: {}".format(type(e).__name__, e)


class P2PSendReq(BaseModel):
    msg: str = ""


class P2PDebugReq(BaseModel):
    enabled: bool = False


@app.post("/api/p2p/debug")
def p2p_debug(req: P2PDebugReq):
    """Toggle verbose P2P logging. OFF (the default) keeps message CONTENTS out
    of the logs -- they still appear in the chat window, just never in the log
    output/file. ON logs everything (connection events, errors, contents)."""
    global _p2p_debug
    _p2p_debug = bool(req.enabled)
    p2p.set_debug(_p2p_debug)
    p2p.file_set_debug(_p2p_debug)     # file transfer honours the same switch
    return {"ok": True, "debug": _p2p_debug}


@app.get("/api/p2p/poll")
def p2p_poll(since: int = 0):
    """Drain chat + lifecycle events since `since` (poll-based bridge to the
    frontend). Returns the events and the new cursor."""
    events, cursor = p2p.HUB.since(int(since))
    return {"events": events, "cursor": cursor, "connected": p2p.HUB.connected()}


@app.post("/api/p2p/send")
def p2p_send(req: P2PSendReq):
    """Send a chat line on the active connection (host's peer, or the client's
    socket -- whichever this instance holds)."""
    conn = p2p.HUB.active()
    if conn is None:
        return {"ok": False, "error": "not connected"}
    ok = p2p.send_chat(conn, req.msg or "")
    if ok:
        _p2p_client_log("[CHAT SENT] {}".format(req.msg) if _p2p_debug else "[CHAT SENT]")
    return {"ok": ok, "error": None if ok else "send failed"}


@app.post("/api/p2p/chat/connect")
def p2p_chat_connect(req: P2PConnectReq):
    """Client side: open a PERSISTENT authenticated connection and start the
    chat read loop. Extends the Phase 1 one-shot /api/p2p/connect (which is left
    untouched) -- reuses the same auth handshake, then keeps the socket open."""
    global _p2p_client_conn, _p2p_client_thread
    ip = (req.ip or "").strip()
    if not ip:
        return {"ok": False, "error": "missing IP"}
    with _p2p_client_lock:
        if _p2p_client_conn is not None:           # drop any previous session
            try:
                _p2p_client_conn.close()
            except Exception:
                pass
            _p2p_client_conn = None
        try:
            s = p2p.open_chat_client(ip, int(req.port), (req.code or "").strip(),
                                     log=_p2p_client_log)
        except Exception as e:
            # WinError 10013 etc. -> a clear firewall/VPN message, no crash
            return {"ok": False, "result": None, "error": _p2p_friendly_error(e)}
        if s is None:
            return {"ok": False, "result": "auth_fail", "error": "bad or expired code"}
        _p2p_client_conn = s
        peer = f"{ip}:{req.port}"
        _p2p_client_thread = threading.Thread(
            target=p2p.run_chat_loop, args=(s, peer, _p2p_client_log),
            name="p2p-client", daemon=True)
        _p2p_client_thread.start()
    return {"ok": True, "result": "auth_ok", "error": None}


@app.post("/api/p2p/chat/disconnect")
def p2p_chat_disconnect():
    """Close this instance's client connection (host side uses /host/stop)."""
    global _p2p_client_conn
    try:
        p2p.file_reset()           # abort any in-flight transfers (in-memory)
    except Exception:
        pass
    with _p2p_client_lock:
        if _p2p_client_conn is not None:
            try:
                _p2p_client_conn.close()
            except Exception:
                pass
            _p2p_client_conn = None
    return {"ok": True}


# ------------------------------------------------------------------------
# P2P Phase 5: file transfer over the SAME authenticated TLS connection.
# All logic lives in p2p/filetransfer.py; these routes are the thin HTTP
# bridge (upload the bytes / set the save dir). Progress is delivered through
# the existing /api/p2p/poll event stream (kind == "file").
# ------------------------------------------------------------------------
class P2PFileCfgReq(BaseModel):
    location: str = "desktop"        # 'desktop' | 'downloads' | 'custom'
    custom_path: str = ""


@app.get("/api/p2p/file/dirs")
def p2p_file_dirs():
    """Well-known save dirs for the download-location setting UI."""
    return {"ok": True, **p2p.file_dirs()}


@app.post("/api/p2p/file/config")
def p2p_file_config(req: P2PFileCfgReq):
    """Set where INCOMING files are saved (in-memory; the frontend persists the
    choice in localStorage)."""
    path = p2p.file_configure_download(req.location, req.custom_path)
    return {"ok": True, "path": path}


@app.post("/api/p2p/file/send")
async def p2p_file_send(request: Request, name: str = "", chunk_size: int = 0,
                        lanes: int = 0):
    """Raw-body upload (?name=&chunk_size=&lanes=) of a file to transfer to the
    peer. STREAMING: the request body is written to a temp spool file in fixed-size
    pieces (never held whole in RAM), then a FileSender streams it chunk-by-chunk
    off disk over the socket and deletes the spool when done. This keeps server
    memory flat for arbitrarily large files (multi-GB safe)."""
    if not p2p.HUB.connected():
        return {"ok": False, "error": "not connected"}
    # spool to a randomly-named temp file (no original name on disk -> privacy)
    fd, spool = tempfile.mkstemp(prefix="aeye-xfer-", suffix=".part")
    size = 0
    try:
        with os.fdopen(fd, "wb") as f:
            async for piece in request.stream():     # ~64 KB pieces from Starlette
                if piece:
                    f.write(piece)
                    size += len(piece)
    except Exception as e:
        try:
            os.remove(spool)
        except Exception:
            pass
        return {"ok": False, "error": "upload failed: {}".format(type(e).__name__)}
    if size == 0:
        try:
            os.remove(spool)
        except Exception:
            pass
        return {"ok": False, "error": "empty upload"}
    # hand the spool to the sender; it streams from disk and deletes it afterwards
    return p2p.file_start_send(name, spool, size,
                               chunk_size or p2p.DEFAULT_CHUNK,
                               lanes or p2p.DEFAULT_LANES, cleanup=True)


def _p2p_chat_shutdown():
    try:
        p2p.file_reset()
    except Exception:
        pass
    try:
        if _p2p_client_conn:
            _p2p_client_conn.close()
    except Exception:
        pass


_atexit.register(_p2p_chat_shutdown)


BANNER = r"""
                 ______________
            .--''              ''--.
         .-'      .----------.      '-.
       .'       .' .--------. '.       '.
      /        /  /   @@@@   \  \        \
     ;        |  |   @@@@@@   |  |        ;
      \        \  \   @@@@   /  /        /
       '.       '. '--------' .'       .'
         '-.      '----------'      .-'
            '--..______________..--'

     A E Y E  ::  the eye is watching at
"""

def _autoreload_hf() -> None:
    """On startup, bring back the last HuggingFace chat model IF it's still cached
    on disk (so we never trigger a silent multi-GB re-download). Runs in a thread."""
    state = _load_state()
    model_id = state.get("last_hf_model")
    if not model_id or not hf_available():
        return
    try:
        repos, _, _ = _hf_cache_repos()
        if not any(r["repo"] == model_id for r in repos):
            return                       # not cached anymore -- skip
    except Exception:
        return
    with HF.lock:
        if HF.state in ("loading", "ready"):
            return
        HF.model = HF.tokenizer = None
        HF.state, HF.model_id, HF.error = "loading", model_id, None
        HF.started = time.time()
    _hf_load(model_id, bool(state.get("last_hf_four_bit")),
             bool(state.get("last_hf_trust_remote_code")))


def _autoreload_image() -> None:
    """On startup, bring back the last image model IF it's still cached on disk
    (so we never trigger a silent multi-GB re-download). Runs in a thread."""
    model_id = _load_state().get("last_image_model")
    if not model_id or not img_available():
        return
    try:
        repos, _, _ = _hf_cache_repos()
        if not any(r["repo"] == model_id for r in repos):
            return                       # not cached anymore -- skip
    except Exception:
        return
    with IMG.lock:
        if IMG.state in ("loading", "busy", "ready"):
            return
        IMG.pipe = None
        IMG.state, IMG.model_id, IMG.error = "loading", model_id, None
        IMG.started = time.time()
    _img_load(model_id)


def _autoreload_video() -> None:
    """On startup, bring back the last video model IF it's still cached on disk
    (never trigger a silent multi-GB re-download). Runs in a thread."""
    model_id = _load_state().get("last_video_model")
    if not model_id or not vid_available():
        return
    try:
        repos, _, _ = _hf_cache_repos()
        if not any(r["repo"] == model_id for r in repos):
            return                       # not cached anymore -- skip
    except Exception:
        return
    with VID.lock:
        if VID.state in ("loading", "busy", "ready"):
            return
        VID.pipe = None
        VID.state, VID.model_id, VID.error = "loading", model_id, None
        VID.started = time.time()
    _vid_load(model_id)


def _autoreload_models() -> None:
    """Bring back the last chat model, THEN the image, THEN the video pipeline.
    Strictly sequential: loading them at once makes them fight over VRAM and
    accelerate sharding fails with 'cannot copy out of meta tensor' on small
    cards. (Each restores only if still cached; on a tight card a load may fail
    for lack of VRAM -- that's fine, it just stays idle.)"""
    _autoreload_hf()
    _autoreload_image()
    _autoreload_video()


def _diag_extras() -> None:
    """Log import status + tracebacks for the sidecar packages. Gated behind
    AEYE_DIAG=1 so it never runs in normal use. Invaluable for diagnosing the
    frozen-bundle-vs-extras shadowing."""
    import importlib
    import traceback
    for mod in ("numpy", "huggingface_hub", "torch", "transformers",
                "sentence_transformers", "faster_whisper", "faiss", "pypdf"):
        try:
            m = importlib.import_module(mod)
            print(f"[extras-diag] OK   {mod} {getattr(m, '__version__', '?')} "
                  f"<- {getattr(m, '__file__', '?')}", flush=True)
        except Exception:
            print(f"[extras-diag] FAIL {mod}:\n{traceback.format_exc()}", flush=True)


def _warmup() -> None:
    """Background priming shared by the web (server.py) and desktop (desktop.py)
    entrypoints."""
    if os.environ.get("AEYE_DIAG"):
        threading.Thread(target=_diag_extras, daemon=True).start()
    # warm the hardware scan in the background so /api/catalog is instant
    threading.Thread(target=scan_hardware, daemon=True).start()
    threading.Thread(target=_cpu_temp_loop, daemon=True).start()
    threading.Thread(target=_hwinfo_loop, daemon=True).start()
    _sys_stats()   # prime CPU%/net counters so the first meter poll is real
    # load any cached trending models instantly, then refresh them if online
    _load_catalog_cache()
    threading.Thread(target=_refresh_catalog, daemon=True).start()
    # first run: pull the default Piper voice so TTS works out of the box
    threading.Thread(target=_ensure_default_voice, daemon=True).start()
    # NOTE: models are NOT auto-loaded on startup anymore -- loading chat + image
    # + video at once ate a lot of RAM. The frontend shows a startup picker
    # (/api/autoload/options + /api/autoload) so the user chooses what to restore.


if __name__ == "__main__":
    import uvicorn
    _warmup()
    print(BANNER + f"     http://{HOST}:{PORT}\n")
    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
