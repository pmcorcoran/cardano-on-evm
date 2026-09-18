"""Reviewable archive policy shared by candidate assembly and download verification."""
import hashlib
import io
from pathlib import Path, PurePosixPath
import tarfile
import re
import stat
import zipfile

MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
MAX_ARCHIVE_FILES = 20000
PACKAGES = ['wallet', 'protocol', 'enrollment', 'sdk', 'submission', 'contracts']
CONTRACTS = ['PreparedTableValidator', 'PreparedTableFactory', 'ProfileAccountFactory', 'ProfilePreparationFactory',
             'RestrictedExecutionHook', 'TargetAllowlistPolicy', 'SelectorAllowlistPolicy', 'Kernel', 'KernelFactory']
CONTRACT_MANIFEST_FIELDS = {'package', 'version', 'addressDerivationMode', 'compiler', 'contractsSha256', 'buildSha256',
                            'compilerInputIdentity', 'settings', 'kernelSettings', 'artifacts', 'sources', 'versions', 'audited'}
FORBIDDEN_PARTS = {'node_modules', '.git', '.local', '__pycache__', '.venv', '.npmrc', '.netrc'}


def safe_name(name):
    path = PurePosixPath(name)
    if not name or '\\' in name or path.is_absolute() or '..' in path.parts or path.as_posix() != name:
        raise ValueError('Noncanonical archive path: ' + name)
    if any(ord(c) < 32 or ord(c) == 127 for c in name):
        raise ValueError('Control character in archive path')
    return path


def read_archive(path_or_bytes):
    """Reject links, duplicates, traversal and resource bombs before extraction."""
    options = {'fileobj': io.BytesIO(path_or_bytes)} if isinstance(path_or_bytes, bytes) else {'name': str(path_or_bytes)}
    files, size = {}, 0
    with tarfile.open(mode='r:gz', **options) as archive:
        seen = set()
        for member in archive:
            safe_name(member.name)
            if member.name in seen:
                raise ValueError('Duplicate archive member: ' + member.name)
            seen.add(member.name)
            if len(seen) > MAX_ARCHIVE_FILES:
                raise ValueError('Archive has too many files')
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError('Archive links/special files are forbidden: ' + member.name)
            size += member.size
            if size > MAX_ARCHIVE_BYTES:
                raise ValueError('Archive exceeds expanded size limit')
            data = archive.extractfile(member).read()
            files[member.name] = {'data': data, 'sha256': hashlib.sha256(data).hexdigest(),
                                  'size': len(data), 'executable': bool(member.mode & 0o111)}
    return files


def read_zip(data):
    """Browser traces are ZIPs; apply the same path/link/size checks to them."""
    files, seen, size = {}, set(), 0
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        for member in archive.infolist():
            name = member.filename.removesuffix('/') if member.is_dir() else member.filename
            safe_name(name)
            if name in seen:
                raise ValueError('Duplicate ZIP member: ' + name)
            seen.add(name)
            if len(seen) > MAX_ARCHIVE_FILES:
                raise ValueError('ZIP has too many files')
            if member.is_dir():
                continue
            mode = member.external_attr >> 16
            if stat.S_IFMT(mode) not in {0, stat.S_IFREG}:
                raise ValueError('ZIP links/special files are forbidden: ' + name)
            size += member.file_size
            if size > MAX_ARCHIVE_BYTES:
                raise ValueError('ZIP exceeds expanded size limit')
            content = archive.read(member)
            files[name] = {'data': content, 'sha256': hashlib.sha256(content).hexdigest(),
                           'size': len(content), 'executable': bool(mode & 0o111)}
    return files


def no_residue(name):
    path = safe_name(name)
    if set(path.parts) & FORBIDDEN_PARTS:
        raise ValueError('Unexpected runtime/cache/config file in archive: ' + name)
    lower = path.name.lower()
    if lower.startswith('.env') and lower != '.env.example':
        raise ValueError('Environment credentials are forbidden in archives')
    if lower.endswith(('.pem', '.key', '.p12', '.pfx', '.keystore', '.sqlite', '.sqlite-wal', '.sqlite-shm', '.pyc')):
        raise ValueError('Unexpected secret/database/compiled residue: ' + name)


def check_package(files, name, version):
    """SDKs contain the documented source/ESM/declarations, never runtime trees."""
    import json
    if name not in PACKAGES:
        raise ValueError('Unexpected package')
    required = {'package/package.json', 'package/LICENSE', 'package/README.md'}
    required |= {'package/index.js', 'package/index.d.ts', 'package/manifest.json'} if name == 'contracts' else {'package/dist/index.js', 'package/dist/index.d.ts'}
    if not required <= set(files):
        raise ValueError('Package is missing expected files: ' + name)
    for path in files:
        no_residue(path)
        parts = PurePosixPath(path).parts
        if len(parts) < 2 or parts[0] != 'package':
            raise ValueError('Package tarball must use package/ prefix')
        rel = PurePosixPath(*parts[1:])
        if str(rel) in {'package.json', 'LICENSE', 'README.md', 'CHANGELOG.md'}:
            continue
        if name != 'contracts':
            if not ((rel.parts[0] == 'src' and rel.name.endswith('.ts')) or (rel.parts[0] == 'dist' and rel.name.endswith(('.js', '.d.ts')))):
                raise ValueError('Unexpected library file: ' + path)
        elif not (str(rel) in {'index.js', 'index.d.ts', 'manifest.json', 'THIRD_PARTY_NOTICES.md'} or
                  rel.parts[0] == 'artifacts' and rel.suffix == '.json' or
                  rel.parts[0] == 'contracts' and rel.suffix == '.sol' or rel.parts[0] == 'vendor'):
            raise ValueError('Unexpected contracts file: ' + path)
    meta = json.loads(files['package/package.json']['data'])
    if meta.get('name') != '@cardano-on-evm/' + name or meta.get('version') != version:
        raise ValueError('Package identity does not match coordinated version')
    if name == 'contracts':
        manifest = json.loads(files['package/manifest.json']['data'])
        if manifest.get('version') != version or manifest.get('package') != meta['name']:
            raise ValueError('Contract build manifest identity differs')
        if set(manifest) != CONTRACT_MANIFEST_FIELDS or manifest.get('addressDerivationMode') != 'portable':
            raise ValueError('Contract build manifest must describe only the current portable artifacts')
        artifacts = manifest['artifacts']
        if sorted(item['name'] for item in artifacts) != sorted(CONTRACTS):
            raise ValueError('Contract artifact allowlist differs')
        expected_artifacts = {'package/artifacts/' + contract + '.json' for contract in CONTRACTS}
        if {path for path in files if path.startswith('package/artifacts/')} != expected_artifacts:
            raise ValueError('Contract artifact files differ from the allowlist')
        source_paths = []
        for item in manifest['sources']:
            source = str(safe_name(item['file']))
            if not source.startswith(('contracts/', 'vendor/')):
                raise ValueError('Unexpected contract source path')
            member = 'package/' + source
            if member not in files or hashlib.sha256(files[member]['data']).hexdigest() != item['sha256']:
                raise ValueError('Contract source bytes differ from manifest')
            source_paths.append(member)
        if len(source_paths) != len(set(source_paths)):
            raise ValueError('Duplicate contract source mapping')
        if {path for path in files if path.startswith(('package/contracts/', 'package/vendor/'))} != set(source_paths):
            raise ValueError('Contract source files differ from manifest')
        for item in artifacts:
            if item['artifact'] != 'artifacts/' + item['name'] + '.json':
                raise ValueError('Contract artifact mapping differs')
            data = files['package/' + item['artifact']]['data']
            artifact = json.loads(data)
            if (hashlib.sha256(data).hexdigest() != item['artifactSha256'] or artifact.get('contractName') != item['name'] or
                    artifact.get('sourceName') != item['source'] or 'package/' + item['source'] not in source_paths):
                raise ValueError('Contract artifact identity differs')
            for field, digest_field in [('bytecode', 'creationSha256'), ('deployedBytecode', 'runtimeTemplateSha256')]:
                if not re.fullmatch(r'0x(?:[a-fA-F0-9]{2})+', artifact.get(field, '')):
                    raise ValueError('Contract bytecode must be linked')
                if hashlib.sha256(bytes.fromhex(artifact[field][2:])).hexdigest() != item[digest_field]:
                    raise ValueError('Contract bytecode identity differs')
    for kind in ['dependencies', 'optionalDependencies', 'peerDependencies']:
        for dep, wanted in meta.get(kind, {}).items():
            if dep == '@pimlico/alto' or re.match(r'^npm:@pimlico/alto(?:@|$)', wanted) or dep.startswith('@cardano-on-evm/') and (dep.split('/')[1] not in PACKAGES or wanted != version):
                raise ValueError('Forbidden or mismatched package dependency: ' + dep)
    return meta


def records(files):
    return [{'path': name, **{key: item[key] for key in ['sha256', 'size', 'executable']}}
            for name, item in sorted(files.items())]


def extract_for_scan(files, destination, depth=0, budget=None):
    """Unpack nested tarballs too; compressed secrets must not evade Gitleaks."""
    if depth > 5:
        raise ValueError('Archive nesting exceeds limit')
    if budget is None:
        budget = [0, 0]
    destination = Path(destination)
    for name, item in files.items():
        no_residue(name)
        budget[0] += item['size']
        budget[1] += 1
        if budget[0] > MAX_ARCHIVE_BYTES * 2 or budget[1] > MAX_ARCHIVE_FILES * 2:
            raise ValueError('Nested archive expanded size exceeds limit')
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(item['data'])
        if name.endswith(('.tar.gz', '.tgz')):
            nested = read_archive(item['data'])
            extract_for_scan(nested, target.parent / (target.name + '.contents'), depth + 1, budget)
        elif name.endswith('.zip'):
            extract_for_scan(read_zip(item['data']), target.parent / (target.name + '.contents'), depth + 1, budget)
