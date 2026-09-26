"""Puts scripts/ on sys.path so tests import the `acr` package; exposes fixture paths."""
import os
import sys

SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if SCRIPTS not in sys.path:
    sys.path.insert(0, SCRIPTS)
FIXTURES = os.path.join(SCRIPTS, "tests", "fixtures")
ACR_PY = os.path.join(SCRIPTS, "acr.py")
