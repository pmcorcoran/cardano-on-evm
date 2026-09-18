import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Reports use a fresh explicit JSON path and cannot replace or alias inputs. */
export function releaseEvidenceOutput(path: string, inputs: readonly string[] = []): string {
  if (!path || !path.endsWith('.json')) throw new Error('An explicit JSON report output path is required');
  const output = resolve(path), directory = dirname(output);
  for (const input of inputs) {
    const resolved = resolve(input);
    if (output === resolved) throw new Error('Report output must not replace an input');
    try { if (output === realpathSync(resolved)) throw new Error('Report output must not alias an input'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  try {
    const file = lstatSync(output);
    if (!file.isFile() || file.nlink !== 1) throw new Error('Report output must not be a symbolic or hard link');
    throw new Error('Report output already exists; use a fresh path');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let ancestor = directory;
  while (true) {
    try {
      if (!lstatSync(ancestor).isDirectory() || realpathSync(ancestor) !== ancestor) throw new Error('Report output directory must not use symbolic links');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      ancestor = dirname(ancestor);
    }
  }
  mkdirSync(directory, { recursive: true });
  return output;
}
