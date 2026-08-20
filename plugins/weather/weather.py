import subprocess
import sys

location = " ".join(sys.argv[1:]).strip()
if not location:
    print("Location required. Ask the user for city and state.")
    sys.exit(0)

subprocess.run("curl wttr.in/" + location.lower(), shell=True)
