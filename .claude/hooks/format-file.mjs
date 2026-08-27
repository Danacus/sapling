#!/usr/bin/env node
// PostToolUse(Edit|Write) — format-on-save.
//
// Replaces the "run `pnpm format` after editing" instruction in CLAUDE.md with
// something deterministic. Always uses the *pinned* node_modules prettier, so
// the bare-npx failure mode (prettier's own defaults reformatting whole files)
// cannot happen here. `.prettierignore` is honoured by prettier itself even for
// explicitly-passed paths — verified — so vendored `sherpa-onnx-*.js` and all
// markdown are skipped without this script knowing anything about them.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const FORMATTABLE = new Set(['.ts', '.js', '.mjs', '.cjs', '.svelte', '.css', '.json', '.html']);

const bail = () => process.exit(0);

let input;
try {
	input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
	bail();
}

const file = input?.tool_input?.file_path;
const root = input?.cwd || process.env.CLAUDE_PROJECT_DIR;
if (!file || !root) bail();

const abs = path.resolve(root, file);
if (!abs.startsWith(path.resolve(root) + path.sep)) bail(); // outside the project
if (!FORMATTABLE.has(path.extname(abs))) bail();
if (!existsSync(abs)) bail();

const bin = path.join(root, 'node_modules', '.bin', 'prettier');
if (!existsSync(bin)) bail(); // deps not installed — never block editing over formatting

const run = spawnSync(bin, ['--write', '--ignore-unknown', abs], {
	cwd: root,
	encoding: 'utf8'
});

if (run.status !== 0) {
	// Non-blocking: the edit stands. A non-zero prettier here almost always means
	// the file no longer parses, which is worth knowing now rather than at `pnpm check`.
	const why = (run.stderr || run.error?.message || '').trim().split('\n')[0];
	process.stderr.write(`prettier could not format ${path.relative(root, abs)}: ${why}\n`);
	process.exit(1);
}
process.exit(0);
