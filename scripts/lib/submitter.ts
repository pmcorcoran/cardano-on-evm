import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';

/** Load a submitter locally. Never print the returned account or environment. */
export function loadSubmitter(file: string, variable: string) {
  let config: Record<string, string | undefined>;
  try { config = parseEnv(readFileSync(file, 'utf8')); }
  catch { throw new Error('Unable to read or parse the submitter configuration file'); }
  const value = config[variable]?.trim();
  if (!value || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('The selected submitter variable is missing or is not a 32-byte hex key');
  }
  try {
    const account = privateKeyToAccount((value.startsWith('0x') ? value : `0x${value}`) as Hex);
    return { account, config };
  } catch { throw new Error('The configured submitter key is not valid'); }
}
