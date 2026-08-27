#!/usr/bin/env node
// PreToolUse(Bash) — block the package-manager mistakes this repo has already paid for.
//
// These were prose rules in CLAUDE.md, which means they held most of the time.
// Here they hold every time, and cost zero instruction budget.

import { readFileSync } from 'node:fs';

const RULES = [
	{
		// `npx prettier` resolves an *unpinned* prettier with its own defaults
		// (2 spaces, trailing commas, width 80) and silently reformats whole files.
		test: /(^|[;&|]\s*)(npx|pnpm\s+dlx|npm\s+exec|yarn\s+dlx)\s+(--\S+\s+)*prettier\b/,
		reason:
			'Never invoke an unpinned prettier: it resolves a different version with prettier’s own defaults and reformats whole files, burying the real diff. Use `pnpm format` (or `pnpm format:check`), which uses the repo-pinned 3.9.6 and .prettierrc.'
	},
	{
		// Bare `prettier ...` — not the node_modules one, not `pnpm exec`.
		test: /(^|[;&|]\s*)prettier\s/,
		reason:
			'Use `pnpm format` / `pnpm format:check` rather than a bare `prettier`, so the repo-pinned version and .prettierrc apply.'
	},
	{
		// The repo is pnpm-only: package.json pins the pnpm version for corepack and
		// Cloudflare Pages installs with it. npm/yarn here desync the lockfile.
		test: /(^|[;&|]\s*)(npm|yarn)\s+(i|install|add|remove|ci)\b/,
		reason: 'This repo is pnpm-only (packageManager pins pnpm for corepack and Cloudflare Pages). Use pnpm.'
	}
];

let input;
try {
	input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
	process.exit(0);
}

const command = input?.tool_input?.command;
if (typeof command !== 'string') process.exit(0);

for (const rule of RULES) {
	if (rule.test.test(command)) {
		process.stdout.write(
			JSON.stringify({
				hookSpecificOutput: {
					hookEventName: 'PreToolUse',
					permissionDecision: 'deny',
					permissionDecisionReason: rule.reason
				}
			})
		);
		process.exit(0);
	}
}
process.exit(0);
