#!/usr/bin/env python3
"""Check that ordinary Git publication and the release inventory agree.

Read the real index only. Non-Git source exports use disposable Git metadata to
evaluate ignore rules. Markdown checks use publication paths, never local-only
files that happen to exist on the validation host.
"""
import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import posixpath
import re
import subprocess
import sys
import tempfile
from urllib.parse import unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from ci.evidence import canonical, inventory, out_allowed, source_path, write_json

REQUIRED = {
    '.gitignore', '.gitattributes', '.editorconfig', '.env.example', '.gitleaks.toml',
    'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'SECURITY.md',
    'CODE_OF_CONDUCT.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'versions.json',
    '.github/CODEOWNERS', '.github/PULL_REQUEST_TEMPLATE.md',
    '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md',
    '.github/workflows/check.yml', '.github/workflows/release.yml', '.github/workflows/version.yml',
    '.github/dependabot.yml', '.github/codeql/config.yml',
    'security/dependency-exceptions.json', 'licenses/supplemental.json',
    'infra/bundler/package.json', 'infra/bundler/package-lock.json', 'infra/bundler/upstream.json',
    'infra/bundler/LICENSE.Alto', 'infra/bundler/build-tools/package.json',
    'infra/bundler/build-tools/package-lock.json', 'infra/bundler/build-tools/remappings.txt',
    'infra/bundler/build-tools/solc-shim.mjs', 'vendor/sources.json',
    'vendor/entrypoint-v07/artifacts/EntryPoint.json', 'vendor/entrypoint-v07/artifacts/EntryPointSimulations.json',
    'vendor/entrypoint-v07/LICENSE', 'vendor/kernel/LICENSE.txt', 'vendor/scl/LICENSE',
    'vendor/solady/LICENSE.txt', 'vendor/openzeppelin-v5.0.2/LICENSE',
    'fixtures/contract-bytecode-pins.json', 'fixtures/generated-cip8.json', 'fixtures/wallet-signatures.json',
    'fixtures/wycheproof-ed25519.json', 'fixtures/wycheproof-provenance.json', 'fixtures/LICENSE.Wycheproof',
    'infra/bundler/tests/fixtures/strict-validation.json',
    *('fixtures/address-derivation-v1/' + name for name in ['inputs.json', 'protocol-vectors.json', 'backend-vectors.json', 'provenance.json']),
    *('packages/' + name + '/package.json' for name in ['contracts', 'wallet', 'protocol', 'enrollment', 'submission', 'sdk']),
    *('packages/' + name + '/LICENSE' for name in ['wallet', 'protocol', 'enrollment', 'submission', 'sdk']),
    *('packages/' + name + '/src/index.ts' for name in ['wallet', 'protocol', 'enrollment', 'submission', 'sdk']),
}


def publication_candidates(root):
    """Return cached plus ordinary-add candidates, including ignored tracked files."""
    root = Path(root).resolve()
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    with tempfile.TemporaryDirectory(prefix='repository-check-git-') as temporary:
        if (root / '.git').exists():
            prefix = ['git', '-C', str(root)]
        else:
            subprocess.run(['git', 'init', '--quiet', temporary], env=env, check=True, capture_output=True)
            prefix = ['git', '--git-dir=' + str(Path(temporary) / '.git'), '--work-tree=' + str(root)]
        result = subprocess.run([*prefix, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
                                env=env, cwd=root, check=True, capture_output=True)
        return sorted(set(os.fsdecode(path) for path in result.stdout.split(b'\0') if path))


def prose(markdown, inline=True):
    """Remove fenced/indented examples, HTML code and inline code spans."""
    lines, fence, list_indent = [], None, 0
    for line in markdown.splitlines():
        content = re.sub(r'^ {0,3}(?:> ?)+', '', line)
        item = re.match(r'^\s*(?:[-+*]|\d+[.)])\s+', content)
        indent = len(content) - len(content.lstrip(' '))
        if item and not fence:
            list_indent = item.end()
            content = content[item.end():]
        elif list_indent and content.strip() and indent < list_indent and not fence:
            list_indent = 0
        elif list_indent:
            content = content[min(indent, list_indent):]
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})', content)
        if fence:
            if re.match(r'^ {0,3}' + re.escape(fence[0]) + '{' + str(len(fence)) + r',}\s*$', content):
                fence = None
            lines.append('')
        elif marker:
            fence = marker[1]
            lines.append('')
        elif not item and content.startswith(('    ', '\t')):
            lines.append('')
        else:
            lines.append(line)
    text = '\n'.join(lines)
    text = re.sub(r'<!--.*?-->|<(pre|code)\b[^>]*>.*?</\1>', '', text, flags=re.S | re.I)
    if inline:
        text = re.sub(r'(`+).*?\1', '', text, flags=re.S)
    return text


def destination(text):
    text = text.strip()
    if text.startswith('<') and '>' in text:
        return text[1:text.index('>')]
    # Spaces in destinations must be angle-bracketed or escaped.
    return re.split(r'(?<!\\)\s', text, maxsplit=1)[0]


def markdown_links(markdown):
    text = prose(markdown)
    definitions = {}
    def define(match):
        definitions[' '.join(match[1].lower().split())] = destination(match[2])
        return ''
    text = re.sub(r'^ {0,3}\[([^\]\n]+)\]:\s*(.+)$', define, text, flags=re.M)
    targets = []
    # Balance parentheses so filenames/URLs containing them are supported.
    pattern = re.compile(r'!?\[[^\]\n]*\]\(')
    while match := pattern.search(text):
        cursor, depth, escaped = match.end(), 1, False
        while cursor < len(text) and depth:
            char = text[cursor]
            if not escaped:
                if char == '(':
                    depth += 1
                elif char == ')':
                    depth -= 1
            escaped = char == '\\' and not escaped
            cursor += 1
        if depth:
            break
        targets.append(destination(text[match.end():cursor - 1]))
        text = text[:match.start()] + text[cursor:]
    def reference(match):
        label = ' '.join((match[2] or match[1]).lower().split())
        targets.append(definitions.get(label, 'missing-reference:' + label))
        return ''
    text = re.sub(r'!?\[([^\]\n]+)\]\[([^\]\n]*)\]', reference, text)
    for match in re.finditer(r'!?\[([^\]\n]+)\]', text):
        label = ' '.join(match[1].lower().split())
        if label in definitions:
            targets.append(definitions[label])
    targets.extend(match[2] for match in re.finditer(r'\b(?:href|src)\s*=\s*([\'"])(.*?)\1', text, re.I))
    return [re.sub(r'\\([\\ ()])', r'\1', html.unescape(target)) for target in targets]


def markdown_anchors(markdown):
    text = prose(markdown, inline=False)
    headings = list(re.finditer(r'^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$', text, re.M))
    headings += list(re.finditer(r'^([^\n]+)\n {0,3}(?:=+|-+)\s*$', text, re.M))
    anchors, counts = set(), {}
    for match in sorted(headings, key=lambda match: match.start()):
        heading = match[1]
        heading = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', heading)
        heading = re.sub(r'<[^>]*>|[`*~]', '', heading)
        slug = re.sub(r'[^\w\- ]', '', html.unescape(heading).lower()).replace(' ', '-')
        count = counts.get(slug, 0)
        counts[slug] = count + 1
        anchors.add(slug + (f'-{count}' if count else ''))
    anchors.update(match[2] for match in re.finditer(r'\b(?:id|name)\s*=\s*([\'"])(.*?)\1', prose(markdown), re.I))
    return anchors


def check_repository(root, required=None):
    root = Path(root).resolve()
    errors = []
    candidates = publication_candidates(root)
    candidate_set = set(candidates)
    try:
        rows = inventory(root)
    except (ValueError, OSError) as error:
        rows = []
        errors.append(str(error))
    selected = {row['path'] for row in rows}
    for name in candidates:
        path = root / name
        if path.is_symlink() or not path.is_file() or path.resolve() != path:
            errors.append('Non-regular publication input: ' + name)
        if not source_path(name):
            errors.append('Prohibited or unclassified publication input: ' + name)
    for name in sorted(candidate_set - selected):
        errors.append('Git candidate missing from release inventory: ' + name)
    for name in sorted(selected - candidate_set):
        errors.append('Release input omitted by Git publication rules: ' + name)
    for name in sorted(REQUIRED if required is None else required):
        if name not in candidate_set or not (root / name).is_file():
            errors.append('Missing required publication input: ' + name)
    notices = root / 'licenses/supplemental.json'
    if notices.is_file():
        for notice in json.loads(notices.read_text()):
            name = notice['file']
            if name not in candidate_set or (root / name).resolve() != root / name:
                errors.append('Missing required supplemental notice: ' + name)
            elif hashlib.sha256((root / name).read_bytes()).hexdigest() != notice['sha256']:
                errors.append('Supplemental notice checksum mismatch: ' + name)
    vendor = root / 'vendor/sources.json'
    if vendor.is_file():
        for component in json.loads(vendor.read_text()):
            for path, expected in component['files'].items():
                name = 'vendor/' + component['name'] + '/' + path
                if name not in candidate_set or not (root / name).is_file() or (root / name).resolve() != root / name:
                    errors.append('Missing required pinned vendor input: ' + name)
                elif hashlib.sha256((root / name).read_bytes()).hexdigest() != expected:
                    errors.append('Pinned vendor checksum mismatch: ' + name)
    markdown = {name: (root / name).read_text() for name in candidates
                if name.lower().endswith(('.md', '.markdown')) and not name.startswith('vendor/') and (root / name).is_file() and not (root / name).is_symlink()}
    anchors = {name: markdown_anchors(content) for name, content in markdown.items()}
    checked = 0
    for name, content in markdown.items():
        for target in markdown_links(content):
            if target.startswith('missing-reference:'):
                errors.append(f'{name}: undefined Markdown reference {target.split(":", 1)[1]}')
                continue
            url = urlsplit(target)
            if url.scheme or url.netloc:
                if url.scheme == 'file':
                    errors.append(f'{name}: machine-local link {target}')
                continue
            checked += 1
            path = unquote(url.path)
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), path)) if path else name
            if path.startswith('/'):
                resolved = posixpath.normpath(path.lstrip('/'))
            directory = any(item.startswith(resolved.rstrip('/') + '/') for item in candidates)
            if resolved not in candidate_set and not directory:
                errors.append(f'{name}: link is outside publication inputs: {target}')
            elif url.fragment and resolved in candidate_set and resolved.lower().endswith(('.md', '.markdown')):
                if resolved not in anchors:
                    anchors[resolved] = markdown_anchors((root / resolved).read_text())
                if unquote(url.fragment).removeprefix('user-content-') not in anchors[resolved]:
                    errors.append(f'{name}: missing Markdown anchor: {target}')
    return {'status': 'failed' if errors else 'passed', 'publicationFileCount': len(candidates),
            'inventoryFileCount': len(rows), 'sourceInventoryHash': hashlib.sha256(canonical(rows)).hexdigest(),
            'markdownFilesChecked': len(markdown), 'localLinksChecked': checked, 'errors': errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default='.')
    parser.add_argument('--out', help='Optional ignored local JSON report')
    args = parser.parse_args()
    try:
        report = check_repository(args.root)
        if args.out:
            out_allowed(args.root, args.out)
            write_json(args.out, report)
        print(json.dumps(report, indent=2))
        return int(report['status'] != 'passed')
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print('Repository check failed: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
