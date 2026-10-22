#!/usr/bin/env python3
"""Summarise a JUnit XML report and enforce CI rules on it (used by .github/workflows/ci.yml).

    python3 scripts/check_junit.py reports/backend-integration.xml --title "Backend integration" \\
        --min-tests 1 --no-skips

Prints the totals (and appends a Markdown table to $GITHUB_STEP_SUMMARY when set), then exits
non-zero if:
  - the report is missing or unreadable,
  - fewer than --min-tests tests ran (catches a suite that silently collected nothing),
  - --no-skips is given and any test was skipped. The backend integration tests skip when
    Postgres is unreachable, so in CI a skip means the database was never exercised.

Reads the pytest and Vitest JUnit formats. Failures and errors are reported but not enforced
here: the test runner's own exit code already fails the job. Stdlib only.
"""

import argparse
import os
import sys
import xml.etree.ElementTree as ET
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("report", type=Path, help="JUnit XML file")
    parser.add_argument("--title", default=None, help="Heading for the summary")
    parser.add_argument("--min-tests", type=int, default=0, help="Fail below this many tests")
    parser.add_argument("--no-skips", action="store_true", help="Fail if any test was skipped")
    args = parser.parse_args()
    title = args.title or args.report.stem

    try:
        root = ET.parse(args.report).getroot()
    except (OSError, ET.ParseError) as e:
        print(f"FAIL  {title}: cannot read {args.report}: {e}", file=sys.stderr)
        return 1

    cases = list(root.iter("testcase"))
    skipped = [c for c in cases if c.find("skipped") is not None]
    failed = [c for c in cases if c.find("failure") is not None or c.find("error") is not None]
    passed = len(cases) - len(skipped) - len(failed)

    def name(case: ET.Element) -> str:
        return f"{case.get('classname', '')}::{case.get('name', '')}".lstrip(":")

    lines = [
        f"### {title}",
        "",
        "| Tests | Passed | Failed | Skipped |",
        "|---:|---:|---:|---:|",
        f"| {len(cases)} | {passed} | {len(failed)} | {len(skipped)} |",
    ]
    for label, group in (("Failed", failed), ("Skipped", skipped)):
        if group:
            lines += ["", f"{label}:", ""]
            for case in group:
                detail = next(iter(case), None)
                reason = (detail.get("message") or "").strip() if detail is not None else ""
                lines.append(f"- `{name(case)}`" + (f": {reason}" if reason else ""))
    summary = "\n".join(lines) + "\n"
    print(summary)
    if step_summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(step_summary, "a", encoding="utf-8") as f:
            f.write(summary + "\n")

    problems = []
    if len(cases) < args.min_tests:
        problems.append(f"only {len(cases)} tests ran, expected at least {args.min_tests}")
    if args.no_skips and skipped:
        problems.append(f"{len(skipped)} skipped, and skips are not allowed here")
    for problem in problems:
        print(f"FAIL  {title}: {problem}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
