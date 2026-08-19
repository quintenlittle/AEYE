import sys
text = sys.argv[1] if len(sys.argv) > 1 else ""
print(f"{len(text.split())} words, {len(text)} chars")
