"""AEYE desktop -- the server and UI in one native window.

Runs the same FastAPI app as server.py, but instead of opening a browser it
embeds the UI in a native window (pywebview on top of Windows' built-in
WebView2). One process, one window; closing the window shuts everything down.
Launch with aeye.bat (or: .venv\\Scripts\\pythonw.exe desktop.py).
"""
import os
import socket
import sys
import threading
import time

# resolve resource/data roots first (creates the AppData tree in a frozen build)
import paths  # noqa: E402

ROOT = paths.RESOURCE_DIR

# under pythonw there is no console -- keep prints/tracebacks in a log file
# (in AppData when frozen, in the repo when running from source)
if sys.stdout is None or sys.stderr is None:
    _log = open(paths.LOG_FILE, "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stderr = _log

import server  # noqa: E402  (needs the stdout shim above -- it prints on import)


def _serve() -> None:
    import uvicorn
    uvicorn.run(server.app, host=server.HOST, port=server.PORT, log_level="warning")


def _wait_for_server(timeout: float = 20.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with socket.create_connection((server.HOST, server.PORT), timeout=1):
                return True
        except OSError:
            time.sleep(0.2)
    return False


def _wait_port_free(timeout: float = 12.0) -> bool:
    """A quickly-relaunched instance must not attach to the dying previous
    process -- wait for it to release the port so OUR server (with the
    auto-reloaded models) is the one the window talks to."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            s.bind((server.HOST, server.PORT))
            return True
        except OSError:
            time.sleep(0.3)
        finally:
            s.close()
    return False


ICON = paths.resource("static", "aeye.ico")

# app palette (static/style.css :root) -- keep the chrome seamless with the UI
BG_RGB = 0x060A07      # --bg      near-black
ACCENT_RGB = 0x48F0C8  # --accent  teal


def _style_window(window) -> None:
    """Windows 11 dressing: paint the title bar + border in the app background
    (reads as black), tint the caption text with the accent, and hang the eye
    icon on the window/taskbar. If the OS can't recolor the bar (pre-Win11
    DWM), blank the title so the bar stays quiet instead."""
    import ctypes
    try:
        hwnd = ctypes.c_void_p(int(window.native.Handle.ToInt64()))
    except Exception:
        return
    dwm = ctypes.windll.dwmapi

    def _dwm_color(attr: int, rgb: int) -> int:
        bgr = ((rgb & 0xFF) << 16) | (rgb & 0xFF00) | (rgb >> 16)  # COLORREF
        return dwm.DwmSetWindowAttribute(hwnd, attr,
                                         ctypes.byref(ctypes.c_int(bgr)), 4)

    ok = _dwm_color(35, BG_RGB)        # DWMWA_CAPTION_COLOR
    _dwm_color(34, BG_RGB)             # DWMWA_BORDER_COLOR (seamless edge)
    _dwm_color(36, ACCENT_RGB)         # DWMWA_TEXT_COLOR
    if ok != 0:                        # can't paint it black -> hide the text
        window.set_title("")

    user32 = ctypes.windll.user32
    user32.LoadImageW.restype = ctypes.c_void_p
    for which, size in ((0, 16), (1, 32)):     # ICON_SMALL, ICON_BIG
        hicon = user32.LoadImageW(None, ICON, 1, size, size, 0x0010)
        if hicon:                              # IMAGE_ICON, LR_LOADFROMFILE
            user32.SendMessageW(hwnd, 0x0080, which, ctypes.c_void_p(hicon))


def _enable_context_menus(window) -> None:
    """Re-enable WebView2's native right-click menu (copy / cut / paste /
    select all + spelling suggestions on editable fields).

    pywebview only turns the default context menu on when debug=True
    (edgechromium sets AreDefaultContextMenusEnabled = _state['debug']), so a
    normal launch has NO right-click menu at all. We flip just that one setting
    on the underlying WebView2 control -- WITHOUT enabling browser accelerator
    keys / devtools -- so users get the same editing + spellcheck menu the
    Claude desktop app has. Editing shortcuts (Ctrl+C/V/X/A) already work in
    fields regardless; this is purely the menu."""
    def _find_webview(ctl):
        try:
            if 'WebView2' in ctl.GetType().Name:
                return ctl
            for child in ctl.Controls:
                found = _find_webview(child)
                if found:
                    return found
        except Exception:
            pass
        return None

    try:
        wv = _find_webview(window.native)
    except Exception:
        wv = None
    if wv is None:
        return

    def _prune_menu(sender, args):
        """Drop 'More tools' (submenu) and 'Send tab to your devices' from the
        native menu, leaving the editing + spelling entries. Matched by the
        stable item Name, with an English label fallback."""
        try:
            items = args.MenuItems
            drop = ('other', 'sendToDevices', 'sendPageToDevices')
            for i in range(items.Count - 1, -1, -1):
                it = items[i]
                nm = (getattr(it, 'Name', '') or '')
                lb = (getattr(it, 'Label', '') or '').replace('&', '')
                if (nm in drop or lb.startswith('More tools')
                        or lb.startswith('Send tab') or lb.startswith('Send page')):
                    items.RemoveAt(i)
            # tidy any separator left dangling at the bottom
            while items.Count and 'Separator' in str(items[items.Count - 1].Kind):
                items.RemoveAt(items.Count - 1)
        except Exception:
            pass

    def _apply(*_a):
        try:
            core = wv.CoreWebView2
            core.Settings.AreDefaultContextMenusEnabled = True
            core.ContextMenuRequested += _prune_menu
            # kill WebView2's "Saved info" autofill dropdown (it ignores a
            # field's autocomplete=off). Not all runtime versions expose these,
            # so set each defensively.
            try:
                core.Settings.IsGeneralAutofillEnabled = False
            except Exception:
                pass
            try:
                core.Settings.IsPasswordAutosaveEnabled = False
            except Exception:
                pass
        except Exception:
            pass

    try:
        # CoreWebView2 may still be initializing when the window is shown --
        # apply now if it's ready, otherwise wait for the init-complete event.
        if wv.CoreWebView2 is not None:
            _apply()
        else:
            wv.CoreWebView2InitializationCompleted += lambda s, e: _apply()
    except Exception:
        pass


def _set_app_id() -> None:
    """Give the process its own taskbar identity. Without this the taskbar
    groups our window under the host `pythonw.exe` and shows ITS generic
    Python icon; with an explicit AppUserModelID, Windows uses the window's
    own icon (set via WM_SETICON below) for the taskbar button instead."""
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("AEYE.Desktop")
    except Exception:
        pass


def _message_box(text: str, title: str = "AEYE") -> None:
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x10)  # MB_ICONERROR
    except Exception:
        pass


def _webview2_installed() -> bool:
    """The pywebview backend needs the Evergreen WebView2 runtime; without it the
    window silently fails to render. Detect it via the EdgeUpdate registry
    entries (per-machine 64/32-bit + per-user), same GUID the installer checks."""
    import winreg
    guid = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    for root, path in (
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\\" + guid),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\EdgeUpdate\Clients\\" + guid),
        (winreg.HKEY_CURRENT_USER, r"Software\Microsoft\EdgeUpdate\Clients\\" + guid),
    ):
        try:
            with winreg.OpenKey(root, path) as k:
                pv, _ = winreg.QueryValueEx(k, "pv")
                if pv and pv not in ("", "0.0.0.0"):
                    return True
        except OSError:
            pass
    return False


def main() -> None:
    import webview
    # pywebview disables downloads by default -- its WebView2 backend cancels
    # every download, so the imagine/dream "download" buttons and the video
    # "Save video as" menu do nothing. Enable them (a native Save dialog pops).
    try:
        webview.settings['ALLOW_DOWNLOADS'] = True
    except Exception:
        pass
    _set_app_id()          # before any window exists
    # WebView2 preflight: without the runtime the window renders nothing and the
    # only trace is aeye.log -- tell the user plainly instead of a blank window.
    if not _webview2_installed():
        _message_box("Microsoft WebView2 Runtime is required to run AEYE.\n\n"
                     "Install the Evergreen WebView2 Runtime from Microsoft "
                     "(or re-run the AEYE installer), then launch AEYE again.")
        os._exit(1)
    server._warmup()
    # if the port stays taken past the wait, another AEYE (or something else) is
    # holding it -- do NOT attach to that foreign/dying server; tell the user.
    if not _wait_port_free():
        _message_box("AEYE appears to be already running "
                     f"(port {server.PORT} is in use).\n\n"
                     "Close the existing AEYE window and try again.")
        os._exit(1)
    threading.Thread(target=_serve, daemon=True).start()
    _wait_for_server()
    # ?boot= busts the webview's cached copy of index.html from previous runs
    url = f"http://{server.HOST}:{server.PORT}/?boot={int(time.time())}"
    # text_select: pywebview blocks highlighting by default -- the user must
    # be able to select/copy chat text like in any browser
    win = webview.create_window(f"AEYE {paths.__version__}", url,
                                # min_size fits the full ASCII skull backdrop
                                # (shown when the eye auto-hides on a narrow
                                # window) without clipping it top/bottom or sides
                                width=1280, height=860, min_size=(1000, 800),
                                maximized=True, text_select=True,
                                background_color="#060a07")
    win.events.shown += lambda *a: (_style_window(win), _enable_context_menus(win))
    # private_mode=False keeps localStorage (TTS prefs, selected model) across runs
    webview.start(private_mode=False,
                  storage_path=paths.WEBVIEW_DIR)
    # hard exit: a graceful teardown garbage-collects multi-GB models and holds
    # the port + VRAM for seconds; the OS reclaims everything instantly instead
    os._exit(0)


if __name__ == "__main__":
    main()
