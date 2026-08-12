"""AEYE universal ad-block -- network-level request blocking in the WebView2 host.

Attaches a CoreWebView2 `WebResourceRequested` filter that cancels requests to
ad/tracker hosts. Because it works at the network layer it covers EVERY frame --
the sidebar browser's proxied pages, the YouTube embed player (kills its video
ads), and anything else -- without touching page DOMs.

`desktop.py` calls `attach(core)` the moment CoreWebView2 is ready (reusing its
proven `_find_webview` access). Everything is guarded so a failure here can never
affect the app: a broken handler just lets the request through.

Rules live in `%APPDATA%\\AEYE\\adblock_rules.txt` (one substring per line,
user-editable); a request is blocked if any rule is a substring of its URL.
Requests to the app itself (localhost) are NEVER blocked.
"""
import os

import paths

RULES_FILE = os.path.join(paths.DATA_DIR, "adblock_rules.txt")

# default block list -- substrings matched against the full request URL. Kept
# deliberately broad for an aggressive block; edit adblock_rules.txt to tune.
DEFAULT_RULES = [
    "doubleclick.net",
    "googlesyndication.com",
    "googleadservices.com",
    "adservice.google.com",
    "ads.youtube.com",
    "google-analytics.com",
    "googletagmanager.com",
    "adnxs.com",
    "taboola.com",
    "outbrain.com",
    "scorecardresearch.com",
    "amazon-adsystem.com",
    "moatads.com",
    "criteo.",
    "pubmatic.com",
    "rubiconproject.com",
    "quantserve.com",
    "adroll.com",
    "/ads/",
    "/advert",
    "/banner",
    "/tracking",
    "/analytics",
    "tracking.",
    "analytics.",
    "telemetry.",
]

_attached = False   # ensure the filter is only wired once per process


def _ensure_rules():
    if not os.path.exists(RULES_FILE):
        try:
            os.makedirs(os.path.dirname(RULES_FILE), exist_ok=True)
            with open(RULES_FILE, "w", encoding="utf-8") as f:
                f.write("# AEYE ad-block -- one URL substring per line; "
                        "lines starting with # are ignored.\n")
                for rule in DEFAULT_RULES:
                    f.write(rule + "\n")
        except OSError:
            pass


def load_rules():
    _ensure_rules()
    rules = []
    try:
        with open(RULES_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip().lower()
                if line and not line.startswith("#"):
                    rules.append(line)
    except OSError:
        pass
    return rules or [r.lower() for r in DEFAULT_RULES]


def _is_local(url: str) -> bool:
    """The AEYE UI and its /api/browse proxy are served from localhost -- never
    block them, so no rule can ever break the app itself."""
    return ("://127.0.0.1" in url or "://localhost" in url or "://[::1]" in url)


def should_block(url: str, rules) -> bool:
    u = (url or "").lower()
    if not u or _is_local(u):
        return False
    return any(rule in u for rule in rules)


def attach(core) -> None:
    """Wire the block filter onto a ready CoreWebView2 (idempotent)."""
    global _attached
    if _attached or core is None:
        return
    rules = load_rules()
    try:
        env = core.Environment
        core.AddWebResourceRequestedFilter("*", 0)   # 0 = ALL resource contexts

        def _handler(sender, args):
            try:
                if should_block(args.Request.Uri, rules):
                    args.Response = env.CreateWebResourceResponse(
                        None, 403, "Blocked", "")
            except Exception:
                pass   # any hiccup -> let the request proceed, never break a page

        core.WebResourceRequested += _handler
        _attached = True
    except Exception as e:
        print("[adblock] attach skipped:", e)
