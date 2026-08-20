"""AEYE weather tool (type:tool plugin).

Fetches the current weather for an EXPLICIT location from wttr.in and prints the
standard AEYE tool contract {"success", "output", "error"} on stdout, which the
agentic-tools runner passes straight through.

Design rules (see the manifest):
  * location is REQUIRED and comes from the user -- we NEVER infer it from IP.
    Called with no/empty location -> a clean contract error asking for city/state.
  * concise, single-line output (no terminal art dumped into chat).
  * pure standard library -- no dependency beyond Python's urllib. wttr.in only
    returns plain text (not HTML) when the User-Agent looks like curl.
"""
import json
import sys
import urllib.parse
import urllib.request

# a compact one-line report: "Seminole, TX: <cond> <temp>, feels <f>, humidity
# <h>, wind <w>". %-codes are wttr.in's format language.
_FORMAT = "%l: %c %t, feels %f, humidity %h, wind %w"
_TIMEOUT = 15


def _emit(success, output=None, error=None):
    print(json.dumps({"success": success, "output": output, "error": error}))


def main():
    location = " ".join(sys.argv[1:]).strip()
    if not location:
        # Backend/tool authoritative response when no location was supplied.
        _emit(False, None, "Location required. Ask the user for city and state.")
        return

    # URL-safe: encode the location AND the format string (spaces -> %20 etc.).
    loc = urllib.parse.quote(location)
    fmt = urllib.parse.quote(_FORMAT)
    url = "https://wttr.in/{}?format={}".format(loc, fmt)
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8.0"})
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            body = resp.read().decode("utf-8", "replace").strip()
    except urllib.error.HTTPError as e:
        # wttr.in answers an unparseable/unknown place with 404 OR 500, so treat
        # both as "confirm the location" rather than a service outage.
        if e.code in (404, 500):
            _emit(False, None, "Unknown location '{}'. Ask the user to confirm "
                  "the city and state.".format(location))
        else:
            _emit(False, None, "weather service error (HTTP {}).".format(e.code))
        return
    except Exception:
        _emit(False, None, "could not reach the weather service. Check the "
              "connection and try again.")
        return

    # wttr.in reports an unknown place as a plain sentence rather than a 404.
    low = body.lower()
    if not body or "unknown location" in low or "we were unable" in low:
        _emit(False, None, "Unknown location '{}'. Ask the user to confirm the "
              "city and state.".format(location))
        return

    _emit(True, body, None)


if __name__ == "__main__":
    main()
