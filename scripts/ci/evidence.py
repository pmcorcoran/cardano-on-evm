"""Small, shared current-run evidence contract for GitHub CI and release gates.

Hashes provide continuity, not authentication. Only a trusted workflow and GitHub
attestations can establish who produced evidence. Local mode can never release.
"""
import argparse
from datetime import datetime, timezone, timedelta
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import subprocess
import sys
import tempfile

SCHEMA_VERSION = 1
PREPACK_SUITES = ["fast-node22", "fast-node24", "fast-node26", "core", "bundler",
                  "security", "codeql-javascript-typescript", "codeql-python", "codeql-actions"]
FINAL_SUITES = PREPACK_SUITES + ["package-consumer", "archive-scan"]
SOURCE_DIRS = {"apps", "contracts", "docs", "examples", "fixtures", "infra", "licenses",
               "packages", "scripts", "tests", "vendor", "evidence", ".github", ".changeset", "security"}
SOURCE_ROOT_FILES = {"package.json", "package-lock.json", "tsconfig.json", "versions.json", "README.md",
                     "rfp.md", "LICENSE", "THIRD_PARTY_NOTICES.md", "CONTRIBUTING.md", "SECURITY.md",
                     "CODE_OF_CONDUCT.md", ".editorconfig", ".gitattributes",
                     ".env.example", ".gitignore", ".gitleaks.toml", ".npmrc", ".actionlint.yaml"}
EXCLUDED_PARTS = {"node_modules", ".local", ".git", "dist", "__pycache__", "esm", ".venv",
                  ".cache", "coverage", "test-results", "playwright-report", ".agents", ".codex",
                  ".claude", ".cursor", ".vscode", ".idea", ".pytest_cache", ".mypy_cache",
                  ".ruff_cache", ".npm", ".pnpm-store", ".turbo", ".secrets", "secrets", ".direnv", ".history"}
GENERATED_CONTRACT_FILES = {"index.js", "index.d.ts", "manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.md"}
HEX64 = re.compile(r"[0-9a-f]{64}\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def timestamp(value):
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("Expected UTC timestamp")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def json_load(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key: " + key)
            result[key] = value
        return result
    return json.loads(Path(path).read_text(), object_pairs_hook=unique,
                      parse_constant=lambda x: (_ for _ in ()).throw(ValueError("Invalid JSON constant " + x)))


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".evidence-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            stream.write(json.dumps(value, indent=2, sort_keys=True) + "\n")
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def source_path(rel):
    rel = PurePosixPath(rel)
    parts = rel.parts
    if not parts or rel.is_absolute() or ".." in parts or set(parts) & EXCLUDED_PARTS:
        return False
    if parts[0] not in SOURCE_DIRS and str(rel) not in SOURCE_ROOT_FILES and not rel.name.endswith((".env.example", ".env.sample", ".env.template")):
        return False
    if parts[0] == "evidence":
        return False
    if parts[:2] == ("licenses", "npm") or str(rel) == "licenses/dependencies.json":
        return False
    if len(parts) == 4 and parts[:3] == ("infra", "bundler", "build-tools") and parts[3] in {"solc-0817", "solc-0823", "solc-0828"}:
        return False  # Generated executable links created by the pinned Alto builder.
    if parts[:2] == ("packages", "contracts") and len(parts) > 2:
        if parts[2] in {"artifacts", "contracts", "vendor"} | GENERATED_CONTRACT_FILES:
            return False
    name = rel.name.lower()
    if name in {"agents.md", "claude.md", "gemini.md", ".ds_store", ".eslintcache", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa", "keystore.json", "private-key.json", "private_key.json"} or name.startswith('keystore-') and name.endswith('.json'):
        return False
    if name.endswith((".pyc", ".log", ".sqlite", ".sqlite-wal", ".sqlite-shm", ".swp", ".swo", "~", ".code-workspace", ".tsbuildinfo")):
        return False
    example = name.endswith((".env.example", ".env.sample", ".env.template"))
    if not example and (name.startswith(".env") or re.search(r"\.env(?:\.|$)", name)):
        return False
    if re.search(r"\.(?:key|keystore|skey)(?:\.|$)", name) or name.endswith((".pem", ".p12", ".pfx", ".p8", ".jks", ".seed", ".mnemonic", ".age", ".gpg", ".kdbx")):
        return False
    return True


def source_files(root):
    """List source inputs, pruning generated/dependency trees before traversal.

    Every included regular file has its bytes and executable bit inventoried.
    Symlinks/special files in the source surface fail rather than silently vanish.
    """
    root = Path(root).resolve()
    found = []
    for directory, dirs, files in os.walk(root, followlinks=False):
        base = Path(directory).relative_to(root)
        kept = []
        for name in sorted(dirs):
            rel = base / name
            if source_path(rel):
                if (root / rel).is_symlink():
                    raise ValueError("Source symlink is forbidden: " + rel.as_posix())
                kept.append(name)
        dirs[:] = kept
        for name in sorted(files):
            rel = base / name
            if not source_path(rel):
                continue
            path = root / rel
            if path.is_symlink() or not stat.S_ISREG(path.lstat().st_mode):
                raise ValueError("Source special file is forbidden: " + rel.as_posix())
            found.append(rel)
    yield from sorted(found, key=lambda p: p.as_posix())


def inventory(root):
    root = Path(root)
    return [{"path": path.as_posix(), "sha256": digest(root / path),
             "executable": bool((root / path).stat().st_mode & 0o111)} for path in source_files(root)]


def inventory_sha256(root):
    return hashlib.sha256(canonical(inventory(root))).hexdigest()


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True, stderr=subprocess.PIPE).strip()


def clean_commit(root):
    root = Path(root).resolve()
    if Path(git(root, "rev-parse", "--show-toplevel")).resolve() != root:
        raise ValueError("The source root must be the Git checkout root")
    commit = git(root, "rev-parse", "HEAD")
    if not SHA.fullmatch(commit):
        raise ValueError("Expected a full Git commit SHA")
    files = list(source_files(root))
    tracked = set(git(root, "ls-files", "-z").split("\0"))
    untracked = [p.as_posix() for p in files if p.as_posix() not in tracked]
    changed = git(root, "diff", "HEAD", "--name-only", "-z").split("\0")
    if untracked or any(source_path(p) for p in changed if p):
        raise ValueError("Source must be committed and unchanged (including documentation and config)")
    if git(root, "diff", "--name-only", "--diff-filter=U"):
        raise ValueError("Unresolved Git conflicts")
    return commit


def out_allowed(root, out):
    root, out = Path(root).resolve(), Path(out).resolve()
    try:
        rel = out.relative_to(root)
    except ValueError:
        return
    if out == root or source_path(rel / "context.json"):
        raise ValueError("Output must be outside inventoried source; use .local/ci or a temporary directory")


def init(root, out, mode):
    root, out = Path(root).resolve(), Path(out).resolve()
    out_allowed(root, out)
    if (out / "context.json").exists():
        raise ValueError("Context already exists; use a fresh output directory for a new run")
    if mode not in {"local", "ci", "candidate"}:
        raise ValueError("Invalid evidence mode")
    if mode == "local":
        try:
            commit = clean_commit(root)
        except (subprocess.CalledProcessError, ValueError):
            commit = None
        run = {"id": "local-" + secrets.token_hex(16), "attempt": "1", "event": "local", "workflow": "local"}
        repository = None
    else:
        commit = clean_commit(root)
        repository = os.environ.get("GITHUB_REPOSITORY", "")
        if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository):
            raise ValueError("GitHub repository identity is required")
        run = {"id": os.environ.get("GITHUB_RUN_ID", ""), "attempt": os.environ.get("GITHUB_RUN_ATTEMPT", ""),
               "event": os.environ.get("GITHUB_EVENT_NAME", ""), "workflow": os.environ.get("GITHUB_WORKFLOW_REF", "")}
        if not re.fullmatch(r"[1-9][0-9]*", run["id"]) or not re.fullmatch(r"[1-9][0-9]*", run["attempt"]) or not run["event"] or not run["workflow"]:
            raise ValueError("GitHub run/attempt/event/workflow identity is required")
        if mode == "candidate" and (run["event"] not in {"push", "workflow_dispatch"} or not run["workflow"].endswith("@refs/heads/main")):
            raise ValueError("Release evidence must originate in a main push or manual main workflow")
    rows = inventory(root)
    if not rows or not (root / "package.json").is_file():
        raise ValueError("Not a complete source checkout")
    context = {"schemaVersion": SCHEMA_VERSION, "kind": "validation-context", "mode": mode,
               "repository": repository, "commit": commit, "run": run, "createdAt": now(),
               "nonce": secrets.token_hex(32), "inventoryVersion": 1,
               "sourceInventoryHash": hashlib.sha256(canonical(rows)).hexdigest(), "sourceFileCount": len(rows)}
    write_json(out / "source-inventory.json", rows)
    write_json(out / "context.json", context)
    return context


def load_context(path):
    value = json_load(path)
    if not isinstance(value, dict) or type(value.get("schemaVersion")) is not int or value.get("schemaVersion") != SCHEMA_VERSION or value.get("kind") != "validation-context":
        raise ValueError("Unsupported evidence context")
    if value.get("mode") not in {"local", "ci", "candidate"} or type(value.get("inventoryVersion")) is not int or value.get("inventoryVersion") != 1:
        raise ValueError("Invalid context mode or inventory version")
    if not HEX64.fullmatch(value.get("sourceInventoryHash", "")) or not HEX64.fullmatch(value.get("nonce", "")):
        raise ValueError("Invalid context hash/nonce")
    if type(value.get("sourceFileCount")) is not int or value["sourceFileCount"] <= 0:
        raise ValueError("Invalid source file count")
    if timestamp(value["createdAt"]) > datetime.now(timezone.utc) + timedelta(minutes=1):
        raise ValueError("Context is in the future")
    run = value.get("run")
    if not isinstance(run, dict) or any(not isinstance(run.get(k), str) or not run[k] for k in ["id", "attempt", "event", "workflow"]):
        raise ValueError("Invalid workflow run identity")
    if value["mode"] != "local":
        if not SHA.fullmatch(value.get("commit", "")) or not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value.get("repository", "")):
            raise ValueError("Invalid repository commit identity")
        if not re.fullmatch(r"[1-9][0-9]*", run["id"]) or not re.fullmatch(r"[1-9][0-9]*", run["attempt"]):
            raise ValueError("Invalid GitHub run ID/attempt")
    return value


def check_source(context, root):
    if inventory_sha256(root) != context["sourceInventoryHash"]:
        raise ValueError("Source inventory changed since this run began")
    if context["mode"] != "local" and clean_commit(root) != context["commit"]:
        raise ValueError("Checkout commit does not match validation context")
    if os.environ.get("GITHUB_ACTIONS") == "true" and context["mode"] != "local":
        for key, env in [("id", "GITHUB_RUN_ID"), ("attempt", "GITHUB_RUN_ATTEMPT")]:
            if context["run"][key] != os.environ.get(env):
                raise ValueError("Context belongs to a different GitHub run/attempt")
        if context["repository"] != os.environ.get("GITHUB_REPOSITORY"):
            raise ValueError("Context belongs to a different repository")


def command_version(command, cwd=None):
    try:
        return subprocess.check_output(command, cwd=cwd, text=True, stderr=subprocess.DEVNULL, timeout=30).strip()
    except (OSError, subprocess.SubprocessError):
        return None


def toolchain(root):
    root = Path(root)
    result = {"node": command_version(["node", "--version"]), "npm": command_version(["npm", "--version"]),
              "python": ".".join(map(str, sys.version_info[:3])), "platform": sys.platform,
              "solc": command_version(["node", "-e", "process.stdout.write(require('solc').version())"], cwd=root)}
    for name in ["anvil", "forge"]:
        binary = os.environ.get(name.upper() + "_BIN", str(root / ".local/tools/foundry" / name))
        result[name] = command_version([binary, "--version"])
    python = os.environ.get("VALIDATION_PYTHON", sys.executable)
    result["playwright"] = command_version([python, "-c", "import importlib.metadata;print(importlib.metadata.version('playwright'))"])
    return result


def safe_evidence_path(root, relative):
    if not isinstance(relative, str) or not relative or "\\" in relative:
        raise ValueError("Invalid evidence path")
    rel = PurePosixPath(relative)
    if rel.is_absolute() or ".." in rel.parts or rel.as_posix() != relative:
        raise ValueError("Evidence path escapes output")
    root = Path(root).resolve()
    target = root / relative
    if not target.resolve().is_relative_to(root):
        raise ValueError("Evidence link escapes output")
    for path in [target, *list(target.parents)[:len(rel.parts) - 1]]:
        if path.is_symlink():
            raise ValueError("Evidence symlinks are forbidden")
    return target


def run(context_path, root, out, suite, command, includes=()):
    context_path, root, out = Path(context_path).resolve(), Path(root).resolve(), Path(out).resolve()
    context = load_context(context_path)
    out_allowed(root, out)
    check_source(context, root)
    if not re.fullmatch(r"[a-z][a-z0-9-]*", suite) or not command:
        raise ValueError("Suite name and command are required")
    report_path = out / "reports" / (suite + ".json")
    if report_path.exists():
        raise ValueError("Suite report exists; start a fresh run instead of replacing evidence")
    log = out / "logs" / (suite + ".log")
    log.parent.mkdir(parents=True, exist_ok=True)
    report = {"schemaVersion": SCHEMA_VERSION, "kind": "validation-report", "suite": suite,
              "contextSha256": digest(context_path), "commit": context["commit"],
              "sourceInventoryHash": context["sourceInventoryHash"], "repository": context["repository"],
              "run": context["run"], "startedAt": now(), "toolchain": toolchain(root), "commands": [], "evidence": []}
    code = 1
    try:
        with log.open("w") as stream:
            completed = subprocess.run(command, cwd=root, stdout=stream, stderr=subprocess.STDOUT)
        code = completed.returncode
        report["commands"].append({"argv": command, "exitCode": code, "log": log.relative_to(out).as_posix()})
        check_source(context, root)
        paths = {log}
        for rel in includes:
            target = safe_evidence_path(out, rel)
            if not target.exists():
                raise ValueError("Declared evidence missing: " + rel)
            if target.is_dir():
                paths.update(p for p in target.rglob("*") if p.is_file() or p.is_symlink())
            else:
                paths.add(target)
        for path in sorted(paths):
            relative = path.relative_to(out).as_posix()
            checked = safe_evidence_path(out, relative)
            if not checked.is_file() or checked == report_path or relative in {"context.json", "source-inventory.json"} or relative.startswith("reports/"):
                raise ValueError("Invalid/self-referential evidence file: " + relative)
            report["evidence"].append({"path": relative, "sha256": digest(checked), "size": checked.stat().st_size})
    except Exception as error:
        code = code or 1
        report["failure"] = str(error)
    report["completedAt"] = now()
    report["status"] = "success" if code == 0 else "failure"
    write_json(report_path, report)
    print(json.dumps({"suite": suite, "status": report["status"], "report": str(report_path)}), flush=True)
    return code if 0 <= code <= 255 else 1


def check_toolchain(report):
    suite, versions = report["suite"], report["toolchain"]
    node = versions.get("node", "") or ""
    if suite == "fast-node22" and node != "v22.18.0":
        raise ValueError("Node 22 fast lane must use 22.18.0")
    if suite == "fast-node24" and not re.fullmatch(r"v24\.\d+\.\d+", node):
        raise ValueError("Node 24 fast lane must use current 24 LTS")
    if suite not in {"fast-node22", "fast-node24"}:
        if node != "v26.8.1" or versions.get("npm") != "11.19.0":
            raise ValueError("Candidate build/test lanes require Node 26.8.1 / npm 11.19.0")
    if suite in {"core", "bundler", "package-consumer"} and not (versions.get("solc") or "").startswith("0.8.30+commit.73712a01"):
        raise ValueError("Candidate Solidity target is 0.8.30+commit.73712a01")
    if suite in {"core", "bundler"}:
        if not re.fullmatch(r"3\.13\.\d+", versions.get("python", "")) or not re.search(r"Version: 1\.8\.1\b", versions.get("anvil") or ""):
            raise ValueError("Candidate local toolchain requires Python 3.13 and Anvil 1.8.1")
    if suite == "bundler" and not re.search(r"Version: 1\.8\.1\b", versions.get("forge") or ""):
        raise ValueError("Candidate bundler requires Forge 1.8.1")
    if suite == "core" and versions.get("playwright") != "1.62.0":
        raise ValueError("Candidate browser target is Playwright 1.62.0")


def verify(context_path, reports_dir, suites, candidate=False, require_fresh=True):
    context_path, reports_dir = Path(context_path).resolve(), Path(reports_dir).resolve()
    context = load_context(context_path)
    if not suites or len(set(suites)) != len(suites):
        raise ValueError("An explicit, nonduplicate required suite list is mandatory")
    if candidate:
        if context["mode"] != "candidate" or not context["commit"] or context["run"]["event"] not in {"push", "workflow_dispatch"} or not context["run"]["workflow"].endswith("@refs/heads/main"):
            raise ValueError("Only a main GitHub candidate context is release eligible")
        if require_fresh and datetime.now(timezone.utc) - timestamp(context["createdAt"]) > timedelta(hours=24):
            raise ValueError("Candidate evidence expired after 24 hours; validate and approve a new candidate")
    results = []
    for suite in suites:
        if not re.fullmatch(r"[a-z][a-z0-9-]*", suite):
            raise ValueError("Invalid suite name")
        path = safe_evidence_path(reports_dir, suite + ".json")
        value = json_load(path)
        if not isinstance(value, dict) or type(value.get("schemaVersion")) is not int or value.get("schemaVersion") != SCHEMA_VERSION or value.get("kind") != "validation-report" or value.get("suite") != suite:
            raise ValueError("Invalid report schema/suite: " + suite)
        for key in ["commit", "sourceInventoryHash", "repository", "run"]:
            if value.get(key) != context[key]:
                raise ValueError("Report identity mismatch: " + suite + "/" + key)
        if value.get("contextSha256") != digest(context_path) or value.get("status") != "success" or value.get("failure"):
            raise ValueError("Report is failed, stale or from another context: " + suite)
        started, completed = timestamp(value["startedAt"]), timestamp(value["completedAt"])
        if started < timestamp(context["createdAt"]) or completed < started or completed > datetime.now(timezone.utc) + timedelta(minutes=1):
            raise ValueError("Invalid report time ordering: " + suite)
        commands, files = value.get("commands"), value.get("evidence")
        if not isinstance(commands, list) or not commands or not isinstance(files, list) or not files:
            raise ValueError("Command results and hashed evidence are required: " + suite)
        if not isinstance(value.get("toolchain"), dict) or not value["toolchain"].get("node") or not value["toolchain"].get("python"):
            raise ValueError("Missing actual toolchain observations: " + suite)
        seen = set()
        for record in files:
            if not isinstance(record, dict) or not HEX64.fullmatch(record.get("sha256", "")) or type(record.get("size")) is not int or record["size"] < 0:
                raise ValueError("Malformed evidence entry")
            rel = record["path"]
            if rel in seen or rel.startswith("reports/"):
                raise ValueError("Duplicate/self-referential evidence")
            seen.add(rel)
            item = safe_evidence_path(reports_dir.parent, rel)
            if not item.is_file() or item.stat().st_size != record["size"] or digest(item) != record["sha256"]:
                raise ValueError("Evidence is missing or changed: " + rel)
        for command in commands:
            if not isinstance(command, dict) or type(command.get("exitCode")) is not int or command["exitCode"] != 0 or not isinstance(command.get("argv"), list) or not command["argv"] or any(not isinstance(a, str) for a in command["argv"]) or command.get("log") not in seen:
                raise ValueError("Failed/unrecorded command: " + suite)
        if candidate:
            check_toolchain(value)
        results.append(value)
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    sub = parser.add_subparsers(dest="operation", required=True)
    start = sub.add_parser("init")
    start.add_argument("--out", required=True)
    start.add_argument("--mode", choices=["local", "ci", "candidate"], default="local")
    inv = sub.add_parser("inventory")
    inv.add_argument("--out")
    execute = sub.add_parser("run")
    execute.add_argument("--context", required=True)
    execute.add_argument("--suite", required=True)
    execute.add_argument("--out", required=True)
    execute.add_argument("--include", action="append", default=[])
    execute.add_argument("command", nargs=argparse.REMAINDER)
    check = sub.add_parser("verify")
    check.add_argument("--context", required=True)
    check.add_argument("--reports", required=True)
    check.add_argument("--suites", nargs="+", required=True)
    check.add_argument("--candidate", action="store_true")
    args = parser.parse_args()
    if args.operation == "init":
        print(json.dumps(init(args.root, args.out, args.mode)))
    elif args.operation == "inventory":
        rows = inventory(args.root)
        if args.out:
            write_json(args.out, rows)
        print(json.dumps({"sourceInventoryHash": hashlib.sha256(canonical(rows)).hexdigest(), "sourceFileCount": len(rows)}))
    elif args.operation == "run":
        command = args.command[1:] if args.command[:1] == ["--"] else args.command
        return run(args.context, args.root, args.out, args.suite, command, args.include)
    else:
        context = load_context(args.context)
        check_source(context, args.root)
        results = verify(args.context, args.reports, args.suites, args.candidate)
        print(json.dumps({"verifiedSuites": [r["suite"] for r in results], "releaseEligible": args.candidate}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:
        print("Evidence gate failed: " + str(error), file=sys.stderr)
        sys.exit(1)
