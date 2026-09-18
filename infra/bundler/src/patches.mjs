import { createHash } from 'node:crypto';

const sha = (text) => createHash('sha256').update(text).digest('hex');
/** Apply only the declared edits to the exact pinned upstream file. */
export function patchedText(content, patch, source = false) {
  const replacements = (source ? patch.sourceReplacements : patch.replacements) ?? [{ find: patch.find, replace: patch.replace }];
  const expected = source ? patch.sourceSha256 : patch.installedSha256;
  let original = content;
  if (sha(original) !== expected) {
    for (const { find, replace } of [...replacements].reverse()) {
      if (original.split(replace).length !== 2) throw new Error('Alto patch is absent, partial or ambiguous');
      original = original.replace(replace, find);
    }
  }
  if (sha(original) !== expected) throw new Error('Alto patch input differs from the pinned source');
  let changed = original;
  for (const { find, replace } of replacements) {
    if (changed.split(find).length !== 2) throw new Error('Alto patch target is ambiguous');
    changed = changed.replace(find, replace);
  }
  return { original, changed };
}
