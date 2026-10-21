"""Scaffold smoke test (#1): the package imports and exposes a version.

Replaced by real unit tests as backend issues land.
"""

import re

import app


def test_package_exposes_semver_version() -> None:
    assert re.fullmatch(r"\d+\.\d+\.\d+", app.__version__)
