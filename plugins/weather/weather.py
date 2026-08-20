import re
import subprocess
import sys

# location comes from either the model's tool arg ({location}) or a typed trigger
# ("weather Seminole, TX" -> {query}); strip any UNfilled template token so a bare
# "weather" doesn't curl the literal text.
raw = re.sub(r"\{[^{}]*\}", " ", " ".join(sys.argv[1:]))
loc = raw.strip().lower().replace(" ", "")

# ask first: no real location -> prompt, do NOT open a cmd window.
BAD = {"", "?", "unknown", "here", "there", "current", "currentlocation",
       "mylocation", "yourlocation", "userlocation", "location", "none",
       "null", "n/a", "na", "tbd", "local", "nearby"}
if loc in BAD or not any(c.isalnum() for c in loc):
    print("Ask the user for their city and state (or ZIP code) first.")
    sys.exit(0)

# open a real cmd window and curl wttr.in in front of the user -- raw output.
subprocess.Popen('start "AEYE weather" cmd /k curl wttr.in/' + loc, shell=True)
print("Opened the weather for " + loc + " in a new window.")
