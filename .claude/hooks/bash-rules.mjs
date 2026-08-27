#!/usr/bin/env node
// PreToolUse(Bash) — make .claude/rules/ fire for Bash-driven work.
//
// Path-scoped rules key on the Read tool. In auto mode files are read with cat
// and changed with sed/heredocs, so the rules never load and their contracts go
// missing exactly when code is being changed. This matches rule globs against
// the paths named in the command instead, and injects each rule at most once
// per session — worst case the old always-loaded CLAUDE.md cost, typically far
// less.
//
// Also drops the timestamp marker that format-changed.mjs uses to tell which
// files this command touched.

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const bail = () => process.exit(0);

let input;
try {
	input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
	bail();
}

const command = input?.tool_input?.command;
const root = input?.cwd;
const session = input?.session_id;
if (typeof command !== 'string' || !root || !session) bail();

const stateDir = path.join(os.tmpdir(), 'claude-rules-' + session);
try {
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(path.join(stateDir, '.marker'), String(Date.now()));
} catch {
	// marker is best-effort
}

const rulesDir = path.join(root, '.claude', 'rules');
if (!existsSync(rulesDir)) bail();

// Heredoc bodies are prose — commit messages, file contents — not paths the
// command operates on. Scanning them matches paths that are merely *mentioned*,
// and because injection is once-per-session a spurious match burns the budget
// for the rule, so a later real edit to that area would get nothing. (Observed:
// a `git commit -F -` whose message named src/lib/db/settings.ts.)
const withoutHeredocs = command.replace(
	/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[\s\S]*?^\s*\1\s*$/gm,
	' '
);

// Paths the command names, e.g. `sed -i ... src/lib/tts/sherpa.ts`.
const PATH_RE = /(?:^|[\s'"=(:])((?:src|server|static)\/[A-Za-z0-9_@.+\-/]+)/g;
const mentioned = [...withoutHeredocs.matchAll(PATH_RE)].map((m) => m[1]);
if (!mentioned.length) bail();

// Minimal glob: ** spans separators, * does not. No middle-** patterns in use.
function globToRe(glob) {
	let out = '';
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === '*') {
			if (glob[i + 1] === '*') {
				out += '.*';
				i++;
			} else {
				out += '[^/]*';
			}
		} else if (c === '?') {
			out += '[^/]';
		} else {
			out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		}
	}
	return new RegExp('^' + out + '$');
}

const chunks = [];
for (const file of readdirSync(rulesDir).filter((f) => f.endsWith('.md'))) {
	const seen = path.join(stateDir, file);
	if (existsSync(seen)) continue; // already injected this session

	const text = readFileSync(path.join(rulesDir, file), 'utf8');
	const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
	if (!fm) continue;
	const globs = [...fm[1].matchAll(/^\s*-\s*"(.+?)"\s*$/gm)].map((m) => globToRe(m[1]));
	if (!globs.some((re) => mentioned.some((p) => re.test(p)))) continue;

	writeFileSync(seen, '');
	chunks.push('--- .claude/rules/' + file + ' ---\n' + text.slice(fm[0].length).trim());
}

if (!chunks.length) bail();

process.stdout.write(
	JSON.stringify({
		hookSpecificOutput: {
			hookEventName: 'PreToolUse',
			additionalContext:
				'This command touches paths governed by project rules. Their contracts:\n\n' +
				chunks.join('\n\n')
		}
	})
);
