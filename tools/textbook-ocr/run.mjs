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

// Cheap vision models worth comparing, one or two per family, all taking a
// strict JSON schema; picked from `--list` on 2026-10-31 (estimated $/page in
// the comments). Ids drift: `--list` prints what OpenRouter serves today, and
// an id it no longer serves is skipped.
const DEFAULT_MODELS = [
	'z-ai/glm-5.3-flash', // 0.0003
	'google/gemma-4-26b-a4b-it', // 0.0007
	'xiaomi/mimo-v2.6-flash', // 0.0010
	'bytedance-seed/seed-2.0-mini', // 0.0011
	'deepseek/deepseek-v4.1-flash', // 0.0011
	'anthropic/claude-haiku-5.5', // 0.0013
	'openai/gpt-6-luna', // 0.0013
	'qwen/qwen3.8-flash', // 0.0014
	'nvidia/nemotron-3.5-super-vl', // 0.0015
	'mistralai/mistral-small-2603', // 0.0017
	'qwen/qwen3-vl-30b-a3b-instruct', // 0.0017
	'google/gemini-3.1-flash-lite', // 0.0038
	'google/gemini-3.5-flash-lite' // 0.0059
];

// A page's rough size in tokens, for ranking models by what a page costs:
// the image and the prompt in, the transcription out. Reasoning tokens come on
// top, and the run records what each call actually cost.
const PAGE_IN = 3000;
const PAGE_OUT = 2000;

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

/** Models that read an image and write text over chat completions: no routers, aliases or batch tiers. */
async function models() {
	const res = await fetch(`${API}/models`);
	const { data } = await res.json();
	return data.filter(
		(m) =>
			m.architecture?.input_modalities?.includes('image') &&
			m.architecture.output_modalities?.join() === 'text' &&
			(m.endpoints ?? ['/api/v1/chat/completions']).includes('/api/v1/chat/completions') &&
			!/:batch$|^~|^openrouter\//.test(m.id) &&
			+m.pricing.prompt >= 0
	);
}

if (args.list) {
	const max = Number(args.max ?? 0.01);
	(await models())
		.map((m) => {
			const params = m.supported_parameters ?? [];
			return {
				id: m.id,
				page:
					+m.pricing.prompt * PAGE_IN + +m.pricing.completion * PAGE_OUT + +(m.pricing.image ?? 0),
				json: params.includes('structured_outputs')
					? 'schema'
					: params.includes('response_format')
						? 'json'
						: '-',
				reasoning: params.includes('reasoning') ? 'reasoning' : '',
				created: new Date(m.created * 1000).toISOString().slice(0, 10)
			};
		})
		.filter((m) => m.page <= max)
		.sort((a, b) => a.page - b.page)
		.forEach((m) =>
			console.log(
				`${m.id.padEnd(50)} ~$${m.page.toFixed(4)}/page  ${m.json.padEnd(6)}  ${m.reasoning.padEnd(9)}  ${m.created}`
			)
		);
	console.log(
		`\n~$/page assumes ${PAGE_IN} tokens in, ${PAGE_OUT} out. --max <dollars> widens the list.`
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

const REASONING = String(args.reasoning ?? 'off'); // off | low | medium | high | default
const MIME = {
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.webp': 'image/webp'
};

async function call(model, page, structured, reasoning = REASONING) {
	const bytes = await readFile(page.image);
	const prompt = template
		.replaceAll('{{target}}', page.truth.target)
		.replaceAll('{{native}}', page.truth.native);
	const body = {
		model,
		temperature: 0,
		max_tokens: 12000,
		usage: { include: true },
		// Copying a page needs no reasoning, and a reasoning model left to it
		// spent the whole budget thinking and never wrote the JSON.
		...(reasoning === 'default'
			? {}
			: {
					reasoning: reasoning === 'off' ? { enabled: false } : { effort: reasoning, exclude: true }
				}),
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

async function attempt(model, page) {
	let reply = await call(model, page, true);
	let structured = true;
	let reasoning = REASONING;
	if (reply.status === 400 && /reasoning is mandatory/i.test(reply.json.error?.message ?? '')) {
		// Some models can't stop reasoning; let them think as little as they allow.
		reasoning = 'low';
		reply = await call(model, page, true, reasoning);
	}
	if (reply.status === 400 || reply.status === 404) {
		// Not every provider takes json_schema; ask for plain JSON instead.
		structured = false;
		reply = await call(model, page, false, reasoning);
	}
	const { status, json, ms } = reply;
	const record = {
		model,
		page: page.name,
		structured,
		reasoning,
		status,
		ms,
		usage: json.usage ?? null
	};
	const content = json.choices?.[0]?.message?.content;
	record.finish = json.choices?.[0]?.finish_reason ?? null;
	try {
		record.result = parse(content);
	} catch (e) {
		record.error = json.error?.message ?? `unparseable reply: ${e.message}`;
		record.raw = content ?? null;
	}
	return record;
}

// One retry on a failed reply, as an import would: a model that loops on
// whitespace inside strict JSON mostly doesn't the second time. Both calls'
// time and cost are counted.
async function run(model, page, round) {
	const first = await attempt(model, page);
	const record = first.error ? await attempt(model, page) : first;
	record.attempts = first.error ? 2 : 1;
	if (first.error) {
		record.firstError = first.error;
		record.ms += first.ms;
		for (const k of ['cost', 'prompt_tokens', 'completion_tokens'])
			if (record.usage && first.usage?.[k] != null)
				record.usage[k] = (record.usage[k] ?? 0) + first.usage[k];
		if (record.usage?.cost_details && first.usage?.cost_details)
			record.usage.cost_details.upstream_inference_cost =
				(record.usage.cost_details.upstream_inference_cost ?? 0) +
				(first.usage.cost_details.upstream_inference_cost ?? 0);
	}
	const ms = record.ms;
	const dir = join(here, 'out', model.replaceAll('/', '__'));
	await mkdir(dir, { recursive: true });
	await writeFile(
		join(dir, `${page.name}${round ? `.r${round}` : ''}.json`),
		JSON.stringify(record, null, 2)
	);
	const spent = record.usage?.is_byok
		? record.usage.cost_details?.upstream_inference_cost
		: record.usage?.cost;
	const cost = spent != null ? `$${spent.toFixed(5)}` : '?';
	console.log(
		`${model.padEnd(45)} ${page.name.padEnd(14)} ${record.error ? 'ERROR ' + record.error.slice(0, 60) : record.attempts > 1 ? 'ok (retried)' : 'ok'}  ${ms}ms  ${cost}`
	);
}

// --repeat N adds N more rounds beside the existing replies (page.r1.json, …);
// the scorer averages every file, so the ranking is not one lucky draw.
const repeat = Number(args.repeat ?? 0);
const rounds = repeat
	? Array.from({ length: repeat }, (_, i) => i + 1 + Number(args.from ?? 0))
	: [0];
const jobs = chosen.flatMap((m) => pages.flatMap((p) => rounds.map((r) => () => run(m, p, r))));
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
