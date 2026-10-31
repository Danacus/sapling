#!/usr/bin/env node
// Transcribe the test pages with each model and save the replies under out/.
// Usage: OPENROUTER_API_KEY=... node run.mjs [--models a,b] [--pages p1,p2] [--list]
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const API = 'https://openrouter.ai/api/v1';
const KEY = process.env.OPENROUTER_API_KEY;

// Cheap vision models worth comparing. Ids drift: `--list` prints what
// OpenRouter serves today, cheapest first, and unknown ids are skipped.
const DEFAULT_MODELS = [
	'google/gemini-2.5-flash-lite',
	'google/gemini-2.5-flash',
	'qwen/qwen2.5-vl-72b-instruct',
	'qwen/qwen3-vl-235b-a22b-instruct',
	'mistralai/mistral-small-3.2-24b-instruct',
	'meta-llama/llama-4-maverick',
	'openai/gpt-4.1-mini'
];

const args = Object.fromEntries(
	process.argv
		.slice(2)
		.reduce(
			(acc, a, i, all) =>
				a.startsWith('--')
					? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : (all[i + 1] ?? true)]]
					: acc,
			[]
		)
);

async function models() {
	const res = await fetch(`${API}/models`);
	const { data } = await res.json();
	return data.filter((m) => m.architecture?.input_modalities?.includes('image'));
}

if (args.list) {
	const vision = await models();
	vision
		.map((m) => ({
			id: m.id,
			in: +m.pricing.prompt * 1e6,
			out: +m.pricing.completion * 1e6,
			img: +(m.pricing.image ?? 0)
		}))
		.sort((a, b) => a.in + a.out - (b.in + b.out))
		.slice(0, 40)
		.forEach((m) =>
			console.log(
				`${m.id.padEnd(50)} $${m.in.toFixed(2)}/M in  $${m.out.toFixed(2)}/M out  $${m.img.toFixed(4)}/img`
			)
		);
	process.exit(0);
}
if (!KEY) {
	console.error('Set OPENROUTER_API_KEY.');
	process.exit(1);
}

const schema = JSON.parse(await readFile(join(here, 'schema.json'), 'utf8'));
const template = await readFile(join(here, 'prompt.txt'), 'utf8');
const truths = (await readdir(join(here, 'truth'))).filter((f) => f.endsWith('.json'));
const wanted = args.pages ? String(args.pages).split(',') : null;
const pages = [];
for (const file of truths) {
	const truth = JSON.parse(await readFile(join(here, 'truth', file), 'utf8'));
	const name = file.replace(/\.json$/, '');
	if (wanted && !wanted.includes(name)) continue;
	const image = join(here, 'pages', truth.image);
	if (!existsSync(image)) {
		console.warn(`skip ${name}: pages/${truth.image} missing`);
		continue;
	}
	pages.push({ name, truth, image });
}

const served = new Set((await models()).map((m) => m.id));
const chosen = (args.models ? String(args.models).split(',') : DEFAULT_MODELS).filter((m) => {
	if (!served.has(m)) console.warn(`skip ${m}: not served as a vision model (try --list)`);
	return served.has(m);
});

const MIME = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp'
};

async function call(model, page, structured) {
	const bytes = await readFile(page.image);
	const prompt = template
		.replaceAll('{{target}}', page.truth.target)
		.replaceAll('{{native}}', page.truth.native);
	const body = {
		model,
		temperature: 0,
		max_tokens: 12000,
		usage: { include: true },
		messages: [
			{
				role: 'user',
				content: [
					{
						type: 'text',
						text: structured
							? prompt
							: `${prompt}\n\nReply with JSON only, matching this schema:\n${JSON.stringify(schema)}`
					},
					{
						type: 'image_url',
						image_url: {
							url: `data:${MIME[extname(page.image)]};base64,${bytes.toString('base64')}`
						}
					}
				]
			}
		],
		response_format: structured
			? { type: 'json_schema', json_schema: { name: 'textbook_page', strict: true, schema } }
			: { type: 'json_object' }
	};
	const started = Date.now();
	const res = await fetch(`${API}/chat/completions`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${KEY}`,
			'Content-Type': 'application/json',
			'X-Title': 'Sapling textbook-ocr test'
		},
		body: JSON.stringify(body)
	});
	const json = await res.json().catch(() => ({}));
	return { status: res.status, json, ms: Date.now() - started };
}

function parse(content) {
	const text = String(content ?? '').replace(/^```(?:json)?\s*|\s*```$/g, '');
	return JSON.parse(text);
}

async function run(model, page) {
	let attempt = await call(model, page, true);
	let structured = true;
	if (attempt.status === 400 || attempt.status === 404) {
		// Not every provider takes json_schema; ask for plain JSON instead.
		structured = false;
		attempt = await call(model, page, false);
	}
	const { status, json, ms } = attempt;
	const record = { model, page: page.name, structured, status, ms, usage: json.usage ?? null };
	const content = json.choices?.[0]?.message?.content;
	try {
		record.result = parse(content);
	} catch (e) {
		record.error = json.error?.message ?? `unparseable reply: ${e.message}`;
		record.raw = content ?? null;
	}
	const dir = join(here, 'out', model.replaceAll('/', '__'));
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, `${page.name}.json`), JSON.stringify(record, null, 2));
	const cost = record.usage?.cost != null ? `$${record.usage.cost.toFixed(5)}` : '?';
	console.log(
		`${model.padEnd(45)} ${page.name.padEnd(14)} ${record.error ? 'ERROR ' + record.error.slice(0, 60) : 'ok'}  ${ms}ms  ${cost}`
	);
}

const jobs = chosen.flatMap((m) => pages.map((p) => () => run(m, p)));
const CONCURRENCY = Number(args.concurrency ?? 4);
await Promise.all(
	Array.from({ length: CONCURRENCY }, async () => {
		while (jobs.length)
			await jobs
				.shift()()
				.catch((e) => console.error(e));
	})
);
console.log('\nScore with: node score.mjs');
