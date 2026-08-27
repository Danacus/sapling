#!/usr/bin/env node
// PostToolUse(Bash) — format-on-save for Bash-driven edits.
//
// The Edit/Write formatter never fires in auto mode, where changes are made
// with sed, heredocs and short scripts. Rather than guess which paths a shell
// command wrote, ask git what is dirty and keep only the files touched since
// bash-rules.mjs stamped its marker at PreToolUse — that scopes the work to
// this command instead of reformatting unrelated work in progress.
//
// Always exits 0 on trouble: a formatter must never break a command.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FORMATTABLE = new Set(['.ts', '.js', '.mjs', '.cjs', '.svelte', '.css', '.json', '.html']);
const MAX_FILES = 40; // a bulk change is `pnpm format`'s job, not this hook's

const bail = () => process.exit(0);

let input;
try {
	input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
	bail();
}

const root = input?.cwd;
const session = input?.session_id;
if (!root) bail();

const bin = path.join(root, 'node_modules', '.bin', 'prettier');
if (!existsSync(bin)) bail();

// Files touched since this command started. Without a marker, fall back to a
// short window rather than sweeping the whole dirty tree.
const markerPath = path.join(os.tmpdir(), 'claude-rules-' + session, '.marker');
let since = Date.now() - 120_000;
try {
	since = Number(readFileSync(markerPath, 'utf8')) || since;
} catch {
	// no marker; keep the fallback window
}

const git = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
	cwd: root,
	encoding: 'utf8'
});
if (git.status !== 0) bail();

const candidates = [];
for (const line of git.stdout.split('\n')) {
	if (!line.trim()) continue;
	// `XY path`, or `XY old -> new` for renames
	const rel = line.slice(3).split(' -> ').pop().replace(/^"|"$/g, '');
	if (!FORMATTABLE.has(path.extname(rel))) continue;
	const abs = path.join(root, rel);
	try {
		if (statSync(abs).mtimeMs >= since) candidates.push(abs);
	} catch {
		// deleted between status and stat
	}
}

if (!candidates.length || candidates.length > MAX_FILES) bail();

// .prettierignore is honoured for explicitly-passed paths, so vendored glue and
// markdown drop out without this hook knowing about them.
const run = spawnSync(bin, ['--write', '--ignore-unknown', ...candidates], {
	cwd: root,
	encoding: 'utf8'
});

if (run.status !== 0) {
	const why = (run.stderr || run.error?.message || '').trim().split('\n')[0];
	process.stderr.write('prettier: ' + why + '\n');
	process.exit(1); // non-blocking notice; the command already ran
}
process.exit(0);
