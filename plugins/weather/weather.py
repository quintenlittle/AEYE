import subprocess
import sys

loc = " ".join(sys.argv[1:]).strip().lower().replace(" ", "")
if not loc:
    print("Location required. Ask the user for city and state.")
    sys.exit(0)

# open a real cmd window and curl wttr.in in front of the user -- the raw output,
# no model interpretation.
subprocess.Popen('start "AEYE weather" cmd /k curl wttr.in/' + loc, shell=True)
print("Opened the weather for " + loc + " in a new window.")
