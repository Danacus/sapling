/**
 * The probe's job is to turn silence into a sentence, so what is worth testing
 * is the mapping from status code to verdict — the part that carries the
 * meaning and the part that would drift if the Worker's replies changed.
 */
import { describe, expect, it } from 'vitest';

import { interpretProbe } from './probe';

describe('interpretProbe', () => {
	it('treats 426 as success', () => {
		// The Worker asks for a WebSocket upgrade only *after* accepting the
		// phrase, so 426 is the proof that authorisation passed.
		expect(interpretProbe(426).ok).toBe(true);
	});

	it('treats 401 as a rejected phrase, and says what to check', () => {
		const result = interpretProbe(401);
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({ reason: 'rejected' });
		expect(result.message).toMatch(/phrase/i);
	});

	it('does not report a 200 as working', () => {
		// `/` answers 200 for a health check. A learner whose URL points at the
		// root rather than the sync endpoint must not be told sync is fine.
		expect(interpretProbe(200).ok).toBe(false);
	});

	it('reports an unexpected status with the number in it', () => {
		const result = interpretProbe(500);
		expect(result.ok).toBe(false);
		expect(result.message).toContain('500');
	});
});
