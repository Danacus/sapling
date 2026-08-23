/**
 * Provisioning CLI: mint an API key for a user (docs/sync.md §7).
 *
 *   pnpm new-key                 # user "default"
 *   pnpm new-key --user daan
 *
 * The key is printed once and never again — only its SHA-256 hash is stored,
 * so there is nothing to recover it from. Losing it means minting another.
 */

import { randomBytes } from 'node:crypto';
import { hashKey } from '../src/auth.ts';
import { openStore } from '../src/db.ts';

function argValue(flag: string): string | undefined {
	const index = process.argv.indexOf(flag);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

const userId = argValue('--user') ?? 'default';
const dbPath = argValue('--db') ?? process.env.SAPLING_DB ?? './sapling.db';

if (userId.startsWith('--')) {
	console.error('--user needs a value, e.g. `pnpm new-key --user daan`');
	process.exit(1);
}

// 32 bytes of CSPRNG output, base64url so it survives a shell, a header and a
// copy-paste without escaping.
const key = randomBytes(32).toString('base64url');

const store = openStore(dbPath);
store.insertKey(hashKey(key), userId, Date.now());
store.close();

console.log(`user:  ${userId}`);
console.log(`db:    ${dbPath}`);
console.log(`key:   ${key}`);
console.log('');
console.log('Store it now — only its hash is saved, so this is the last time it exists.');
console.log('In the app: Settings → Sync → API key. By hand:');
console.log(`  curl -H "Authorization: Bearer ${key}" http://localhost:8787/v1/events`);
