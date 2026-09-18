#!/usr/bin/env python3
"""Enforce high/critical CodeQL findings using the actual generated SARIF."""
from __future__ import annotations
import argparse
import json
import math
from pathlib import Path
import sys
from evidence import json_load


def rule_tables(tool: dict) -> list[tuple[list[dict], dict]]:
    extensions = tool.get("extensions", [])
    if not isinstance(extensions, list):
        raise ValueError("Malformed SARIF tool extensions")
    tables = []
    for component in [tool["driver"], *extensions]:
        rules = component.get("rules", [])
        if not isinstance(rules, list):
            raise ValueError("Malformed SARIF rules")
        by_id = {}
        for rule in rules:
            if not isinstance(rule, dict) or not isinstance(rule.get("id"), str) or not rule["id"] or rule["id"] in by_id:
                raise ValueError("Malformed or duplicate CodeQL rule")
            by_id[rule["id"]] = rule
        tables.append((rules, by_id))
    if not any(rules for rules, _ in tables):
        raise ValueError("Missing SARIF rules")
    return tables


def resolve_rule(result: dict, tool: dict, tables: list) -> dict:
    # SARIF 2.1.0 puts query-pack rules in tool.extensions. Indices are local
    # to the selected component; flattening them can select the wrong severity.
    reference = result.get("rule", {})
    component_ref = reference.get("toolComponent", {})
    component_index = component_ref.get("index", -1)
    if type(component_index) is not int or not -1 <= component_index < len(tables) - 1:
        raise ValueError("Unknown SARIF tool component")
    component = tool["driver"] if component_index == -1 else tool["extensions"][component_index]
    for key in ["name", "guid"]:
        if key in component_ref and component_ref[key] != component.get(key):
            raise ValueError("SARIF tool component identity mismatch")
    rules, by_id = tables[component_index + 1]
    ids = [value[key] for value, key in [(result, "ruleId"), (reference, "id")] if key in value]
    indices = [value[key] for value, key in [(result, "ruleIndex"), (reference, "index")] if key in value]
    if any(not isinstance(value, str) or value not in by_id for value in ids):
        raise ValueError("CodeQL result has unknown rule")
    if any(type(value) is not int or not 0 <= value < len(rules) for value in indices):
        raise ValueError("CodeQL result has invalid rule index")
    matches = [by_id[value] for value in ids] + [rules[value] for value in indices]
    if not matches or any(rule is not matches[0] for rule in matches):
        raise ValueError("CodeQL rule identity mismatch")
    return matches[0]


def inspect(document: dict) -> list[dict]:
    if document.get("version") != "2.1.0" or not isinstance(document.get("runs"), list) or not document["runs"]:
        raise ValueError("Missing or unsupported SARIF runs")
    findings = []
    for run in document["runs"]:
        tool = run.get("tool", {})
        driver = tool.get("driver", {})
        if driver.get("name") != "CodeQL":
            raise ValueError("Expected CodeQL SARIF")
        tables = rule_tables(tool)
        results = run.get("results")
        if not isinstance(results, list):
            raise ValueError("Missing SARIF results")
        for invocation in run.get("invocations", []):
            if invocation.get("executionSuccessful") is not True:
                raise ValueError("CodeQL invocation failed")
            if any(item.get("level") == "error" for item in invocation.get("toolExecutionNotifications", [])):
                raise ValueError("CodeQL reported an execution error")
        for result in results:
            rule = resolve_rule(result, tool, tables)
            rule_id = rule["id"]
            score = rule.get("properties", {}).get("security-severity")
            if score is None:
                if "security" in rule.get("properties", {}).get("tags", []):
                    raise ValueError("Security rule has no severity")
                continue
            if type(score) not in (str, int, float):
                raise ValueError("Invalid CodeQL security severity")
            try:
                score = float(score)
            except (ValueError, TypeError):
                raise ValueError("Invalid CodeQL security severity") from None
            if not math.isfinite(score) or not 0 <= score <= 10:
                raise ValueError("Invalid CodeQL security severity")
            if score >= 7:
                # Suppressions and baselineState do not waive this release gate.
                findings.append({"rule": rule_id, "score": score, "locations": result.get("locations", [])})
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sarif", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    report = {"schema_version": 1, "status": "failed", "files": [], "findings": []}
    try:
        files = sorted(args.sarif.rglob("*.sarif")) if args.sarif.is_dir() else [args.sarif]
        if not files:
            raise ValueError("No CodeQL SARIF files found")
        for path in files:
            report["files"].append(str(path))
            report["findings"].extend(inspect(json_load(path)))
        report["status"] = "failed" if report["findings"] else "passed"
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        report["error"] = str(error)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2) + "\n")
    print(f"CodeQL severity gate: {report['status']}; high/critical findings: {len(report['findings'])}")
    if "error" in report:
        print(report["error"], file=sys.stderr)
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
