/**
 * The probe exists because sync fails silently by design: from Settings, a
 * refused phrase and a healthy connection look identical unless something goes
 * and asks. These three cases are the whole of what it can distinguish.
 */
import { describe, expect, it } from 'vitest';

import { probeSync } from './probe';

const SERVER = 'https://sync.example';
const PHRASE = 'ABCDEFGHJKMNPQRSTVWX';

function replying(reply: Response | Error): { impl: typeof fetch; urls: string[] } {
	const urls: string[] = [];
	const impl: typeof fetch = async (input, init) => {
		urls.push(String(input));
		if (reply instanceof Error) throw reply;
		expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${PHRASE}`);
		return reply;
	};
	return { impl, urls };
}

describe('probeSync', () => {
	it('asks for an empty page, which is the cheapest whole round trip', async () => {
		const { impl, urls } = replying(new Response('{}', { status: 200 }));

		const result = await probeSync(SERVER, PHRASE, impl);

		expect(urls).toEqual([`${SERVER}/pull?after=0&limit=0`]);
		expect(result).toEqual({ ok: true, message: 'Connected to the sync server.' });
	});

	it('reports a refused phrase rather than a broken connection', async () => {
		const { impl } = replying(new Response('Unauthorized\n', { status: 401 }));

		const result = await probeSync(SERVER, PHRASE, impl);

		expect(result).toMatchObject({ ok: false, reason: 'rejected' });
	});

	it('reports an unreachable server when fetch rejects', async () => {
		const { impl } = replying(new TypeError('network error'));

		const result = await probeSync(SERVER, PHRASE, impl);

		expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
	});

	it('names any other status rather than guessing at it', async () => {
		const { impl } = replying(new Response('nope', { status: 502 }));

		const result = await probeSync(SERVER, PHRASE, impl);

		expect(result).toMatchObject({ ok: false, reason: 'unexpected' });
		expect(result.message).toContain('502');
	});
});
