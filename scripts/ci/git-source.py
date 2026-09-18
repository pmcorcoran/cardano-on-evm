"""Export every inventoried source input through an ordinary disposable Git add.

The candidate repository is temporary. The caller's worktree and index are never
written, and ignored required inputs are errors rather than force-added files.
"""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ci.evidence import canonical, inventory, out_allowed, write_json


def git(root, *args, input=None, check=True):
    # An inherited GIT_INDEX_FILE/GIT_DIR must not redirect this disposable add
    # into the real repository. Normal user/system ignore configuration remains.
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    return subprocess.run(['git', '-C', str(root), *args], input=input,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          env=env, check=check)


def export_source(root, destination, expected=None):
    root, destination = Path(root).resolve(), Path(destination).resolve()
    out_allowed(root, destination)
    if destination.exists() and (not destination.is_dir() or any(destination.iterdir())):
        raise RuntimeError('Git source export destination must be empty')
    rows = inventory(root) if expected is None else expected
    if not rows:
        raise RuntimeError('Git source export requires inventoried inputs')
    destination.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='cardano-on-evm-git-source-') as temporary:
        candidate = Path(temporary)
        for item in rows:
            source, target = root / item['path'], candidate / item['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
        if inventory(candidate) != rows:
            raise RuntimeError('Source bytes or executable modes changed during the Git candidate copy')
        git(candidate, 'init', '--quiet')
        # Avoid platform newline conversion, while still letting Git's real
        # attributes/ignore rules determine which bytes and files enter the index.
        git(candidate, 'config', 'core.autocrlf', 'false')
        git(candidate, 'config', 'core.filemode', 'true')
        exclude = git(root, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude', check=False)
        if exclude.returncode == 0:
            source_exclude = Path(os.fsdecode(exclude.stdout).strip())
            if source_exclude.is_file():
                shutil.copy2(source_exclude, candidate / '.git/info/exclude')
        configured = git(root, 'config', '--path', '--get', 'core.excludesFile', check=False)
        if configured.returncode == 0:
            excludes_file = Path(os.fsdecode(configured.stdout).strip()).expanduser()
            if not excludes_file.is_absolute():
                excludes_file = root / excludes_file
            git(candidate, 'config', 'core.excludesFile', str(excludes_file))
        git(candidate, 'add', '--all', '--', '.')
        indexed = {}
        for record in git(candidate, 'ls-files', '--stage', '-z').stdout.split(b'\0'):
            if not record:
                continue
            metadata, path = record.split(b'\t', 1)
            mode, _object, stage = metadata.split(b' ')
            if stage != b'0' or mode not in {b'100644', b'100755'}:
                raise RuntimeError('Git source index contains an unsupported entry')
            indexed[os.fsdecode(path)] = mode == b'100755'
        required = {item['path']: item['executable'] for item in rows}
        missing = sorted(set(required) - set(indexed))
        if missing:
            ignored = git(candidate, 'check-ignore', '--verbose', '--stdin', '-z',
                          input=b'\0'.join(os.fsencode(path) for path in missing) + b'\0', check=False)
            details = os.fsdecode(ignored.stdout).replace('\0', ' ').strip()
            raise RuntimeError('Ordinary git add omitted required source inputs: ' + ', '.join(missing) +
                               ('; ignore rules: ' + details if details else ''))
        if indexed != required:
            raise RuntimeError('Git source index differs from the required paths or executable modes')
        git(candidate, 'checkout-index', '--all', '--prefix=' + str(destination) + os.sep)
        if inventory(destination) != rows:
            raise RuntimeError('Git checkout-index changed source bytes or executable modes')
        if inventory(root) != rows:
            raise RuntimeError('Source inputs changed during the Git export')
    return {'ordinaryAddPassed': True, 'checkoutIndexVerified': True,
            'sourceFileCount': len(rows),
            'sourceInventoryHash': hashlib.sha256(canonical(rows)).hexdigest(),
            'realIndexModified': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='.')
    parser.add_argument('--out', required=True)
    parser.add_argument('--report')
    args = parser.parse_args()
    result = export_source(args.root, args.out)
    if args.report:
        out_allowed(args.root, args.report)
        write_json(args.report, result)
    print(canonical(result).decode())


if __name__ == '__main__':
    main()
