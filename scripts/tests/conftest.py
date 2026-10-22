"""Tests for the repo scripts in scripts/ (run with `make test-scripts`)."""

import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(SCRIPTS_DIR))
