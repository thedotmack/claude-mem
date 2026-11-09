"""Fails (exit 1) when a scripted-session prompt refers to another turn by its number ("since turn 150", "turns 3
and 8", "turn #12"). Real users refer to earlier work by what it was, so a probe that names a turn number tests
something no real session does. Usage: python3 check-prompts.py <prompts file>...
"""
import re, sys

TURN_NUMBER = re.compile(r'\bturns?\s*(?:#|no\.?\s*)?\d+', re.I)
bad = 0
for path in sys.argv[1:]:
    for n, line in enumerate(open(path).read().splitlines(), 1):
        m = TURN_NUMBER.search(line)
        if m: print(f'{path}:{n}: refers to a turn by number ("{m.group(0)}")'); bad += 1
sys.exit(1 if bad else 0)
