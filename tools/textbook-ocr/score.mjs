#!/usr/bin/env node
// Score every reply under out/ against truth/. Usage: node score.mjs [--verbose]
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const verbose = process.argv.includes('--verbose');

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}';
// Lenient on typesetting, strict on characters: width, spacing, curly quotes.
export function norm(s) {
	return String(s ?? '')
		.normalize('NFKC')
		.replace(/[“”„]/g, '"')
		.replace(/[‘’]/g, "'")
		.replace(/\s+/g, ' ')
		.replace(new RegExp(`(?<=[${CJK}]) (?=[${CJK}\\p{P}])|(?<=\\p{P}) (?=[${CJK}])`, 'gu'), '')
		.replace(/ (?=[!?.,;:])/g, '')
		.trim();
}
const key = (s) => norm(s).toLowerCase();
/** Matching ignores a sentence's closing punctuation; `cer` still counts it. */
const matchKey = (s) => key(s).replace(/[。！？!?.,，、]+$/u, '');

/**
 * A line cut into its sentences, so a model that keeps a monologue as one line
 * and one that keeps the book's line breaks are scored alike.
 */
function sentences(text) {
	return norm(text)
		.split(/(?<=[。！？])|(?<=[.!?]) (?=\p{Lu})/u)
		.map((t) => t.trim())
		.filter(Boolean);
}

function levenshtein(a, b) {
	a = [...a];
	b = [...b];
	let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const cur = [i];
		for (let j = 1; j <= b.length; j++)
			cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		prev = cur;
	}
	return prev[b.length];
}

/**
 * The clean-up an importer would run on a reply anyway, so a model is not
 * scored on it: a speaker's dialogue number and colon ("1. Paolo", "A:"), and a
 * translation that repeats the speaker label ("A: What's your name?").
 */
export function tidy(line) {
	const speaker =
		line.speaker?.replace(/^\s*\d+[A-Za-z]?\.\s*/, '').replace(/\s*[:：]\s*$/, '') || null;
	const label = speaker && speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const translation = label
		? (line.translation?.replace(new RegExp(`^\\s*${label}\\s*[:：]\\s*`), '') ?? null)
		: line.translation;
	return { ...line, speaker, translation };
}

/** Every dialogue/sentence line, tidied, speakers resolved through continuation. */
function lines(blocks) {
	const out = [];
	for (const b of blocks ?? []) {
		if (b.kind === 'words') continue;
		let speaker = null;
		for (const raw of b.lines ?? []) {
			const l = tidy(raw);
			if (l.speaker) speaker = l.speaker;
			for (const text of sentences(l.text))
				out.push({ ...l, text, speaker: b.kind === 'dialogue' ? speaker : null });
		}
	}
	return out;
}
const words = (blocks) =>
	(blocks ?? []).filter((b) => b.kind === 'words').flatMap((b) => b.words ?? []);

/** Share of `expected` matched in `got` by `field`, ignoring expected entries where it is absent. */
function agreement(pairs, field) {
	const scored = pairs.filter(([e]) => e[field] != null);
	if (!scored.length) return null;
	return scored.filter(([e, g]) => key(e[field]) === key(g?.[field])).length / scored.length;
}

function score(truth, result) {
	const want = lines(truth.expected.blocks);
	const got = lines(result.blocks);
	const pool = new Map();
	got.forEach((g) => pool.set(matchKey(g.text), [...(pool.get(matchKey(g.text)) ?? []), g]));
	const pairs = want.map((e) => [e, pool.get(matchKey(e.text))?.shift()]);
	const found = pairs.filter(([, g]) => g);
	const joinedWant = want.map((l) => l.text).join(' ');
	const joinedGot = got.map((l) => l.text).join(' ');

	const wantWords = words(truth.expected.blocks);
	const gotWords = new Map(words(result.blocks).map((w) => [key(w.term), w]));
	const wordPairs = wantWords.map((e) => [e, gotWords.get(key(e.term))]);
	const foundWords = wordPairs.filter(([, g]) => g);

	const missing = pairs.filter(([, g]) => !g).map(([e]) => e.text);
	const extra = [...pool.values()].flat().map((g) => g.text);
	return {
		lineRecall: want.length ? found.length / want.length : null,
		extraLines: extra.length,
		cer: joinedWant.length ? levenshtein(joinedWant, joinedGot) / [...joinedWant].length : null,
		speaker: agreement(
			found.filter(([e]) => e.speaker),
			'speaker'
		),
		reading: agreement(found, 'reading'),
		translation: agreement(found, 'translation'),
		wordRecall: wantWords.length ? foundWords.length / wantWords.length : null,
		extraWords: Math.max(0, gotWords.size - foundWords.length),
		grammar: agreement(foundWords, 'grammar'),
		meaning: agreement(foundWords, 'meaning'),
		missing,
		extra,
		missingWords: wordPairs.filter(([, g]) => !g).map(([e]) => e.term)
	};
}

const truths = {};
for (const f of await readdir(join(here, 'truth')))
	truths[f.replace(/\.json$/, '')] = JSON.parse(await readFile(join(here, 'truth', f), 'utf8'));
if (!existsSync(join(here, 'out'))) {
	console.error('Nothing under out/ yet: run run.mjs first.');
	process.exit(1);
}

const COLS = [
	'lineRecall',
	'cer',
	'speaker',
	'reading',
	'translation',
	'wordRecall',
	'grammar',
	'meaning'
];
const pct = (v) => (v == null ? '   -' : `${Math.round(v * 100)}`.padStart(4));
const rows = [];
for (const dir of await readdir(join(here, 'out'))) {
	const per = [];
	let cost = 0,
		ms = 0,
		errors = 0,
		schemaless = 0;
	for (const f of await readdir(join(here, 'out', dir))) {
		const rec = JSON.parse(await readFile(join(here, 'out', dir, f), 'utf8'));
		const truth = truths[rec.page];
		if (!truth) continue;
		// With the learner's own provider key (BYOK) OpenRouter bills nothing
		// and reports what the provider charged instead.
		cost += rec.usage?.is_byok
			? (rec.usage.cost_details?.upstream_inference_cost ?? 0)
			: (rec.usage?.cost ?? 0);
		ms += rec.ms;
		if (!rec.structured) schemaless++;
		// A failed call scores as an empty reply: nothing found.
		if (rec.error) errors++;
		// A reply wrapped in an array is unwrapped, as an importer would.
		const result = Array.isArray(rec.result) ? rec.result[0] : rec.result;
		const s = score(truth, rec.error ? { blocks: [] } : (result ?? { blocks: [] }));
		per.push(s);
		if (verbose) {
			console.log(`\n${rec.model} · ${rec.page}${rec.error ? `  ERROR ${rec.error}` : ''}`);
			console.log('  ' + COLS.map((c) => `${c} ${pct(s[c])}`).join('  '));
			s.missing.forEach((t) => console.log(`  - missing  ${t}`));
			s.extra.forEach((t) => console.log(`  + extra    ${t}`));
			s.missingWords.forEach((t) => console.log(`  - word     ${t}`));
		}
	}
	const mean = (c) => {
		const v = per.map((s) => s[c]).filter((x) => x != null);
		return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
	};
	const n = per.length + errors;
	rows.push({
		model: dir.replaceAll('__', '/'),
		n,
		errors,
		schemaless,
		cost: cost / Math.max(n, 1),
		ms: ms / Math.max(n, 1),
		...Object.fromEntries(COLS.map((c) => [c, mean(c)]))
	});
}

console.log(
	'\nPer page, averaged; a failed call counts as an empty reply. lineRecall: % of expected sentences found; speaker/…: % agreeing with truth; cer: character error rate (lower is better).\n'
);
console.log(
	`${'model'.padEnd(44)} ${COLS.map((c) => c.slice(0, 7).padStart(7)).join(' ')}    $/page    s/page  err`
);
for (const r of rows.sort((a, b) => (b.lineRecall ?? 0) - (a.lineRecall ?? 0)))
	console.log(
		`${r.model.padEnd(44)} ${COLS.map((c) => pct(r[c]).padStart(7)).join(' ')}  ${r.cost.toFixed(5).padStart(8)}  ${(r.ms / 1000).toFixed(1).padStart(8)}  ${r.errors}${r.schemaless ? ` (${r.schemaless} w/o schema)` : ''}`
	);
