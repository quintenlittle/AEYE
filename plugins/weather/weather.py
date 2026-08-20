import subprocess
import sys

loc = " ".join(sys.argv[1:]).strip().lower().replace(" ", "")

# ask first: no real location -> tell the model to ask, do NOT open a cmd window.
BAD = {"", "?", "unknown", "here", "there", "current", "currentlocation",
       "mylocation", "yourlocation", "userlocation", "location", "none",
       "null", "n/a", "na", "tbd", "local", "nearby"}
if loc in BAD or not any(c.isalpha() or c.isdigit() for c in loc):
    print("Ask the user for their city and state (or ZIP code) first, then call "
          "weather with it.")
    sys.exit(0)

# open a real cmd window and curl wttr.in in front of the user -- raw output.
subprocess.Popen('start "AEYE weather" cmd /k curl wttr.in/' + loc, shell=True)
print("Opened the weather for " + loc + " in a new window.")
