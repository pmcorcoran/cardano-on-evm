#!/usr/bin/env python3
"""Lint every workflow with the checksum-pinned actionlint binary."""
import subprocess
import sys
from security_tools import ROOT, install

try:
    files = sorted(str(path) for path in (ROOT / ".github/workflows").glob("*.y*ml"))
    if not files:
        raise ValueError("No workflow files found")
    raise SystemExit(subprocess.call([str(install("actionlint")), "-color", *files], cwd=ROOT))
except (OSError, ValueError) as error:
    print(f"actionlint failed: {error}", file=sys.stderr)
    raise SystemExit(1)
