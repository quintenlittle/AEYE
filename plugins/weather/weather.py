"""AEYE weather tool -- runs the equivalent of `curl wttr.in/<location>` and
returns its raw stdout. Location is required (empty -> ask the user).

Note: curl is called with the location as ONE argument (the space encoded as %20),
because a raw space splits the shell command into two args and curl never receives
the full "city, state" -- so `curl wttr.in/seminole,%20tx` is the working form of
`curl wttr.in/seminole, tx`.
"""
import json
import subprocess
import sys

location = " ".join(sys.argv[1:]).strip()
if not location:
    print(json.dumps({"success": False, "output": None,
                      "error": "Location required. Ask the user for city and state."}))
    sys.exit(0)

url = "wttr.in/" + location.lower().replace(" ", "%20")
p = subprocess.run(["curl", "-s", url], capture_output=True,
                   encoding="utf-8", errors="replace")
print(json.dumps({"success": p.returncode == 0, "output": p.stdout,
                  "error": None if p.returncode == 0 else "weather lookup failed."}))
