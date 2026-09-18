"""Small checksum-pinned installers shared by actionlint and secret scanning."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import platform
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
# Release digests verified against the projects' GitHub release asset metadata.
TOOLS = {
    "actionlint": {
        "version": "1.7.12", "repo": "rhysd/actionlint",
        "x86_64": ("amd64", "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"),
        "aarch64": ("arm64", "325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6"),
    },
    "gitleaks": {
        "version": "8.30.1", "repo": "gitleaks/gitleaks",
        "x86_64": ("x64", "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"),
        "aarch64": ("arm64", "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"),
    },
}


def atomic_write(path: Path, data: bytes, mode=0o644) -> None:
    fd, temporary = tempfile.mkstemp(prefix=".security-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(name: str) -> Path:
    spec = TOOLS[name]
    if platform.system() != "Linux" or platform.machine() not in spec:
        raise ValueError(f"{name}: supported verification platforms are Linux x86_64/aarch64")
    arch, expected = spec[platform.machine()]
    cache = Path(os.environ.get("KERNEL_SECURITY_TOOLS", ROOT / ".local/tools/security"))
    cache.mkdir(parents=True, exist_ok=True)
    filename = f"{name}_{spec['version']}_linux_{arch}.tar.gz"
    archive = cache / filename
    if not archive.exists():
        url = f"https://github.com/{spec['repo']}/releases/download/v{spec['version']}/{filename}"
        with urllib.request.urlopen(url, timeout=90) as response:
            data = response.read()
        if hashlib.sha256(data).hexdigest() != expected:
            raise ValueError(f"{name}: download checksum mismatch")
        atomic_write(archive, data)
    if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
        raise ValueError(f"{name}: cached archive checksum mismatch")
    # Always re-extract the single verified executable; never trust a cached binary.
    executable = cache / f"{name}-{spec['version']}"
    with tarfile.open(archive, "r:gz") as tar:
        member = tar.getmember(name)
        if not member.isfile():
            raise ValueError(f"{name}: archive executable is not a regular file")
        with tar.extractfile(member) as source:
            atomic_write(executable, source.read(), 0o755)
    return executable
