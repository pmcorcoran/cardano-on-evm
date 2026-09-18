#!/usr/bin/env python3
"""Audit all npm lockfiles and scan source/final extracted archives for secrets.

Exit 0 is a successful policy decision, 1 is a finding or unusable tool output.
Raw audit/SBOM outputs remain available when policy checks fail. No command fixes,
installs, publishes or rewrites dependencies or exceptions.
"""
from __future__ import annotations
import argparse
from datetime import date, datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from security_tools import ROOT, TOOLS, install

TREES = {"root": ".", "bundler": "infra/bundler", "bundler-build-tools": "infra/bundler/build-tools"}
SEVERITY = {"info": 0, "low": 1, "moderate": 2, "high": 3, "critical": 4}
EXCEPTION_FIELDS = {"tree", "advisory", "dependency", "version", "severity", "rationale", "owner", "approved_at", "expires_at"}


def parse_json(raw):
    def unique(pairs):
        values = {}
        for key, value in pairs:
            if key in values:
                raise ValueError("Duplicate JSON field: " + key)
            values[key] = value
        return values
    return json.loads(raw, object_pairs_hook=unique,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Invalid JSON constant")))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def exceptions(document: dict, today: date) -> dict:
    if not isinstance(document, dict) or set(document) != {"schema_version", "exceptions"} or type(document["schema_version"]) is not int or document["schema_version"] != 1 or not isinstance(document["exceptions"], list):
        raise ValueError("Invalid exception document")
    records = {}
    for item in document["exceptions"]:
        if not isinstance(item, dict) or set(item) != EXCEPTION_FIELDS or any(not isinstance(v, str) or not v.strip() for v in item.values()):
            raise ValueError("Exception must contain exactly the required nonempty fields")
        if item["tree"] not in TREES.values() or item["severity"] not in SEVERITY:
            raise ValueError("Invalid exception tree/severity")
        if not re.fullmatch(r"GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}", item["advisory"]):
            raise ValueError("Exception advisory must be an exact GHSA ID")
        if not re.fullmatch(r"(?:@[a-z0-9._-]+/)?[a-z0-9._-]+", item["dependency"]) or not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?", item["version"]):
            raise ValueError("Exception must identify one dependency and exact version")
        if not re.fullmatch(r"@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:/[A-Za-z0-9][A-Za-z0-9_-]{0,99})?", item["owner"]) or any(token in item["owner"].lower() for token in ["placeholder", "replace", "todo", "your-owner"]):
            raise ValueError("Exception owner must identify a maintainer or team")
        if len(item["rationale"].strip()) < 20:
            raise ValueError("Exception rationale must explain accepted exposure")
        if any(not re.fullmatch(r"\d{4}-\d{2}-\d{2}", item[field]) for field in ["approved_at", "expires_at"]):
            raise ValueError("Exception dates must be YYYY-MM-DD in UTC")
        approved, expires = date.fromisoformat(item["approved_at"]), date.fromisoformat(item["expires_at"])
        if approved > today or not 0 < (expires - approved).days <= 30:
            raise ValueError("Exception validity must be at most 30 days, starting in the past")
        if today >= expires:
            raise ValueError(f"Expired exception: {item['advisory']} {item['dependency']} {item['version']}")
        key = tuple(item[field] for field in ["tree", "advisory", "dependency", "version"])
        if key in records:
            raise ValueError("Duplicate exception")
        records[key] = item
    return records


def findings(document: dict, lock: dict, tree: str, exit_code: int) -> list[dict]:
    if not isinstance(document, dict) or document.get("error") or document.get("auditReportVersion") != 2:
        raise ValueError("npm audit returned an error or unsupported report")
    vulnerabilities = document.get("vulnerabilities")
    metadata = document.get("metadata", {})
    if not isinstance(vulnerabilities, dict) or not isinstance(metadata, dict) or not isinstance(metadata.get("dependencies"), dict):
        raise ValueError("npm audit returned incomplete metadata")
    counts = metadata.get("vulnerabilities")
    if not isinstance(counts, dict) or any(type(counts.get(key)) is not int or counts[key] < 0 for key in [*SEVERITY, "total"]):
        raise ValueError("npm audit returned invalid finding counts")
    if counts["total"] != len(vulnerabilities) or sum(counts[key] for key in SEVERITY) != counts["total"]:
        raise ValueError("npm audit finding counts disagree")
    if type(exit_code) is not int or exit_code not in [0, 1] or (exit_code == 1 and not vulnerabilities):
        raise ValueError("npm audit tool failed")
    if not isinstance(lock, dict) or lock.get("lockfileVersion") not in [2, 3] or not isinstance(lock.get("packages"), dict):
        raise ValueError("Unsupported or malformed npm lockfile")
    observed = {key: 0 for key in SEVERITY}
    direct = {}
    for name, item in vulnerabilities.items():
        if not isinstance(item, dict) or item.get("name") != name or item.get("severity") not in SEVERITY or not isinstance(item.get("via"), list) or not item["via"] or not isinstance(item.get("nodes"), list) or not item["nodes"]:
            raise ValueError("Malformed npm vulnerability")
        observed[item["severity"]] += 1
        versions = set()
        for node in item["nodes"]:
            package = lock["packages"].get(node)
            if not isinstance(node, str) or not node.endswith("node_modules/" + name) or not isinstance(package, dict) or not isinstance(package.get("version"), str):
                raise ValueError(f"npm finding missing exact lockfile dependency: {name}")
            versions.add(package["version"])
        direct[name] = []
        for via in item["via"]:
            if isinstance(via, str):
                if via not in vulnerabilities:
                    raise ValueError("Unresolved transitive vulnerability")
                continue
            if not isinstance(via, dict) or via.get("dependency") != name or via.get("severity") not in SEVERITY:
                raise ValueError("Malformed npm advisory")
            match = re.fullmatch(r"https://github\.com/advisories/(GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4})", via.get("url", ""))
            if not match:
                raise ValueError("npm advisory requires a canonical GHSA URL")
            for version in versions:
                direct[name].append({"tree": tree, "advisory": match[1], "dependency": name, "version": version, "severity": via["severity"], "url": via["url"]})
    if any(observed[key] != counts[key] for key in SEVERITY):
        raise ValueError("npm audit severities disagree with counts")

    def roots(name, visited):
        if name in visited:
            return []
        items = list(direct[name])
        for via in vulnerabilities[name]["via"]:
            if isinstance(via, str):
                items.extend(roots(via, {*visited, name}))
        return items

    # Keep original vulnerable package/version records, rather than granting a
    # wildcard waiver to each package that depends on a vulnerable package.
    merged = {}
    for name, item in vulnerabilities.items():
        origin = roots(name, set())
        if not origin:
            raise ValueError("Vulnerability graph has no advisory")
        for finding in origin:
            key = tuple(finding[key] for key in ["tree", "advisory", "dependency", "version"])
            prior = merged.setdefault(key, {**finding, "affected_dependents": []})
            prior["affected_dependents"].append(name)
            # The advisory severity belongs to this vulnerable version. A parent
            # may also depend on a different, more severe advisory; do not transfer
            # that parent's aggregate severity to unrelated findings.
    return sorted(merged.values(), key=lambda item: (item["advisory"], item["dependency"], item["version"]))


def evaluate(document, lock, tree, exit_code, approved, today):
    records = exceptions(approved, today)
    rows = findings(document, lock, tree, exit_code)
    for item in rows:
        key = tuple(item[field] for field in ["tree", "advisory", "dependency", "version"])
        record = records.get(key)
        if record is None:
            item["decision"] = "unapproved"
        elif SEVERITY[item["severity"]] > SEVERITY[record["severity"]]:
            item["decision"] = "increased-severity"
        else:
            item["decision"] = "excepted"
            item["exception"] = record
    return {"status": "failed" if any(row["decision"] != "excepted" for row in rows) else "passed", "findings": rows}


def licenses(lock, tree, digest):
    rows = []
    for path, item in sorted(lock["packages"].items()):
        if item.get("link"):
            continue
        name = item.get("name") or path.rsplit("node_modules/", 1)[-1]
        rows.append({"path": path, "name": name, "version": item.get("version"), "license": item.get("license", "UNKNOWN"), "resolved": item.get("resolved"), "integrity": item.get("integrity")})
    return {"schema_version": 1, "tree": tree, "lockfile_sha256": digest, "source": "npm package-lock.json license inventory inputs; UNKNOWN requires review", "packages": rows}


def run_audit(args):
    args.out.mkdir(parents=True, exist_ok=True)
    report = {"schema_version": 1, "created_at": datetime.now(timezone.utc).isoformat(), "status": "failed", "trees": {}}
    approved = parse_json(args.exceptions.read_text())
    write(args.out / "dependency-exceptions.json", approved)
    policy_error = None
    try:
        exceptions(approved, datetime.now(timezone.utc).date())
    except ValueError as error:
        policy_error = str(error)
    for name, tree in TREES.items():
        result = {"status": "failed", "tree": tree}
        report["trees"][name] = result
        try:
            lockpath = ROOT / tree / "package-lock.json"
            lock = parse_json(lockpath.read_text())
            result["lockfile_sha256"] = sha256(lockpath)
            command = ["npm", "audit", "--json", "--package-lock-only", "--ignore-scripts", "--audit-level=high", "--prefix", str(ROOT / tree)]
            process = subprocess.run(command, capture_output=True, text=True, timeout=300)
            (args.out / f"npm-{name}-audit.json").write_text(process.stdout)
            (args.out / f"npm-{name}-audit.stderr.log").write_text(process.stderr)
            result["audit_exit_code"] = process.returncode
            result.update(evaluate(parse_json(process.stdout), lock, tree, process.returncode, approved, datetime.now(timezone.utc).date()))
        except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
            result["error"] = str(error)
        # Run independent inventory producers even when advisories block policy.
        try:
            command = ["npm", "sbom", "--sbom-format=cyclonedx", "--package-lock-only", "--ignore-scripts", "--prefix", str(ROOT / tree)]
            process = subprocess.run(command, capture_output=True, text=True, timeout=300)
            (args.out / f"npm-{name}-sbom.json").write_text(process.stdout)
            (args.out / f"npm-{name}-sbom.stderr.log").write_text(process.stderr)
            result["sbom_exit_code"] = process.returncode
            sbom = parse_json(process.stdout)
            if process.returncode or sbom.get("bomFormat") != "CycloneDX" or not isinstance(sbom.get("components"), list) or not sbom["components"]:
                raise ValueError("npm sbom returned unusable output")
            lock = parse_json((ROOT / tree / "package-lock.json").read_text())
            write(args.out / f"npm-{name}-licenses.json", licenses(lock, tree, result["lockfile_sha256"]))
        except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
            result["status"] = "failed"
            result["inventory_error"] = str(error)
        print(f"Dependency policy {tree}: {result['status']}", flush=True)
    if policy_error:
        report["exception_error"] = policy_error
    elif all(item["status"] == "passed" for item in report["trees"].values()):
        report["status"] = "passed"
    write(args.out / "dependency-audit.json", report)
    return 0 if report["status"] == "passed" else 1


def run_scan(args):
    args.out.parent.mkdir(parents=True, exist_ok=True)
    report = {"schema_version": 1, "status": "failed", "tool": "gitleaks", "version": TOOLS["gitleaks"]["version"], "mode": "git-history" if args.history else "directory", "findings": []}
    try:
        root = args.root.resolve(strict=True)
        if not root.is_dir():
            raise ValueError("Secret scan root must be a directory")
        binary = install("gitleaks")
        with tempfile.TemporaryDirectory(prefix="kernel-gitleaks-") as temporary:
            raw = Path(temporary) / "findings.json"
            # Ignore inline suppression comments and do not read a repository's
            # .gitleaksignore. An archive cannot smuggle in its own scan policy.
            command = [str(binary), "git" if args.history else "dir", str(root), "--config", str(ROOT / ".gitleaks.toml"), "--redact=100", "--no-banner", "--report-format=json", "--report-path", str(raw), "--gitleaks-ignore-path", temporary, "--ignore-gitleaks-allow", "--max-archive-depth=10", "--max-decode-depth=3"]
            if args.history:
                command.append("--log-opts=--all")
            process = subprocess.run(command, capture_output=True, text=True, timeout=900)
            # Only publish sanitized metadata, never secret snippets or raw output.
            data = parse_json(raw.read_text()) if raw.exists() else None
            if process.returncode not in [0, 1] or not isinstance(data, list):
                raise ValueError(f"Gitleaks failed or produced no usable report (exit {process.returncode})")
            for finding in data:
                report["findings"].append({key: finding.get(key) for key in ["RuleID", "File", "StartLine", "EndLine", "Commit", "Fingerprint"]})
            if process.returncode == 0 and not data:
                report["status"] = "passed"
            elif process.returncode == 1 and not data:
                raise ValueError("Gitleaks failed without findings")
    except (OSError, ValueError, TypeError, KeyError, subprocess.SubprocessError) as error:
        report["error"] = str(error)
    write(args.out, report)
    print(f"Secret scan: {report['status']}; {len(report['findings'])} findings; report {args.out}")
    return 0 if report["status"] == "passed" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    audit = sub.add_parser("audit")
    audit.add_argument("--out", type=Path, required=True)
    audit.add_argument("--exceptions", type=Path, default=ROOT / "security/dependency-exceptions.json")
    combined = sub.add_parser("check", help="CI security lane: collect every audit and scan the complete Git history")
    combined.add_argument("--out", type=Path, required=True)
    combined.add_argument("--exceptions", type=Path, default=ROOT / "security/dependency-exceptions.json")
    scan = sub.add_parser("scan")
    scan.add_argument("--root", type=Path, required=True)
    scan.add_argument("--out", type=Path, required=True)
    scan.add_argument("--history", action="store_true")
    validate = sub.add_parser("validate", help="Evaluate saved audit output; for policy review and regression fixtures, not current-run release evidence")
    validate.add_argument("--audit", type=Path, required=True)
    validate.add_argument("--lock", type=Path, required=True)
    validate.add_argument("--tree", choices=TREES.values(), required=True)
    validate.add_argument("--exit-code", type=int, required=True)
    validate.add_argument("--exceptions", type=Path, required=True)
    validate.add_argument("--today", type=date.fromisoformat, default=datetime.now(timezone.utc).date())
    args = parser.parse_args()
    try:
        if args.command == "check":
            audit_status = run_audit(args)
            scan_status = run_scan(argparse.Namespace(root=ROOT, out=args.out / "gitleaks.json", history=True))
            return 1 if audit_status or scan_status else 0
        if args.command == "audit":
            return run_audit(args)
        if args.command == "scan":
            return run_scan(args)
        report = evaluate(parse_json(args.audit.read_text()), parse_json(args.lock.read_text()), args.tree, args.exit_code, parse_json(args.exceptions.read_text()), args.today)
        print(json.dumps(report, indent=2))
        return 0 if report["status"] == "passed" else 1
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f"Security policy failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
