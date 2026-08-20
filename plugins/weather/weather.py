import subprocess
import sys

location = " ".join(sys.argv[1:]).strip()
if not location:
    print("Location required. Ask the user for city and state.")
    sys.exit(0)

# e.g. "Seminole, TX" -> curl wttr.in/seminole,tx  (no space, or curl splits it)
subprocess.run("curl wttr.in/" + location.lower().replace(" ", ""), shell=True)
