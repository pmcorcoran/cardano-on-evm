#!/usr/bin/env python3
"""An explicit-success gate: absent/skipped/cancelled work is never success."""
from __future__ import annotations
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

EVENTS = {"pull_request", "push", "workflow_call", "workflow_dispatch", "schedule", "merge_group"}
LOCAL = ["fast", "core", "bundler"]
SECURITY = ["security", "codeql"]


def required(event: str, candidate: bool = False) -> list[str]:
    if event not in EVENTS:
        raise ValueError(f"Unsupported event: {event}")
    return ["context", *([] if event == "schedule" and not candidate else LOCAL), *SECURITY]


def check(event: str, candidate: bool, needs: dict) -> list[str]:
    if not isinstance(needs, dict):
        raise ValueError("needs must be an object")
    failures = []
    for lane in required(event, candidate):
        entry = needs.get(lane)
        result = entry.get("result") if isinstance(entry, dict) else None
        if result != "success":
            failures.append(f"{lane}: {result or 'missing'}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--event", default=os.environ.get("GITHUB_EVENT_NAME"), required=False)
    parser.add_argument("--candidate", choices=["true", "false"], default="false")
    parser.add_argument("--needs", default=os.environ.get("NEEDS_JSON"))
    parser.add_argument("--context", help="Also require successful current-run evidence from every matrix member")
    parser.add_argument("--reports")
    args = parser.parse_args()
    try:
        failures = check(args.event, args.candidate == "true", json.loads(args.needs or "null"))
    except (ValueError, TypeError) as error:
        print(f"ci-required: {error}", file=sys.stderr)
        return 1
    if failures:
        print("ci-required blocked: " + ", ".join(failures), file=sys.stderr)
        return 1
    if bool(args.context) != bool(args.reports):
        print("ci-required: --context and --reports must be supplied together", file=sys.stderr)
        return 1
    if args.context:
        suites = ["security", "codeql-javascript-typescript", "codeql-python", "codeql-actions"]
        if args.event != "schedule" or args.candidate == "true":
            suites = ["fast-node22", "fast-node24", "fast-node26", "core", "bundler", *suites]
        command = [sys.executable, str(Path(__file__).with_name("evidence.py")), "verify", "--context", args.context, "--reports", args.reports, "--suites", *suites]
        if args.candidate == "true":
            command.append("--candidate")
        if subprocess.call(command):
            return 1
    print("ci-required: every required lane explicitly succeeded")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
