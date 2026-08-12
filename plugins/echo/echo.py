"""Sample AEYE plugin: echo whatever the user typed after the trigger.
The query arrives as a single argv item (the runner never uses a shell)."""
import sys

query = sys.argv[1] if len(sys.argv) > 1 else ""
print("echo plugin received:", repr(query))
words = query.split()
if words:
    print(f"({len(words)} word{'s' if len(words) != 1 else ''})")
    for i, w in enumerate(words, 1):
        print(f"  {i}. {w}")
else:
    print("(nothing after the trigger -- try: echo: hello world)")
