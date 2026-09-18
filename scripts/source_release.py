"""Deterministic source archives using the single CI source inventory policy."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import tarfile
import tempfile
import re

from ci.evidence import source_files


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def release_version(root):
    version = json.loads((Path(root) / 'package.json').read_text())['version']
    if not re.fullmatch(r'(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?', version):
        raise ValueError('Invalid coordinated release version')
    return version


def write_source_archive(root, files, archive):
    write_archive(root, files, archive, 'cardano-on-evm-' + release_version(root))


def write_archive(root, files, archive, prefix=''):
    """Write only explicitly listed regular files; never traverse a symlink."""
    root, archive = Path(root).resolve(), Path(archive)
    archive.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.source-archive-', dir=archive.parent)
    try:
        with os.fdopen(descriptor, 'wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as compressed, tarfile.open(fileobj=compressed, mode='w') as tar:
            for rel in sorted(map(Path, files)):
                source = root / rel
                if rel.is_absolute() or '..' in rel.parts or source.resolve() != source or not source.is_file():
                    raise ValueError('Archive input must be a regular contained file: ' + str(rel))
                info = tar.gettarinfo(str(source), arcname=(prefix + '/' if prefix else '') + rel.as_posix())
                info.uid = info.gid = 0
                info.uname = info.gname = ''
                info.mtime = 0
                info.mode = 0o755 if source.stat().st_mode & 0o111 else 0o644
                with source.open('rb') as stream:
                    tar.addfile(info, stream)
        os.replace(temporary, archive)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def write_json_report(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix='.release-report-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(json.dumps(value, indent=2) + '\n')
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
