/**
 * Room derivation is the sync backend's entire access-control model, and it is
 * also the one rule that two separately-built artifacts have to agree on
 * forever — the client mints the phrase, the Worker names the room from it.
 *
 * So the assertions here are mostly about *stability*. A change that made a
 * phrase hash differently would not fail loudly; it would move every learner
 * into a fresh empty room, which reads as lost data. The pinned digest below is
 * the tripwire for that.
 */
import { describe, expect, it } from 'vitest';

import { formatPhrase, mintPhrase, PHRASE_LENGTH } from '../src/lib/sync/phrase';
import { roomIdForPhrase } from './room';

const PHRASE = 'ABCDEFGHJKMNPQRSTVWX';

describe('roomIdForPhrase', () => {
	it('derives a stable room id', async () => {
		// Pinned on purpose. If this changes, every existing learner's devices
		// stop finding each other's data, so it must only ever change alongside a
		// deliberate bump of DERIVATION_PREFIX.
		await expect(roomIdForPhrase(PHRASE)).resolves.toBe(
			// = sha256('sapling:sync:v1:ABCDEFGHJKMNPQRSTVWX'), checkable by hand.
			'e422ea0a3c5f6dfb4637dad3602cb6abe311deebe063577d0d697624b34c3d33'
		);
	});

	it('never returns the phrase itself', async () => {
		const roomId = await roomIdForPhrase(PHRASE);
		expect(roomId).not.toContain(PHRASE);
		expect(roomId).toMatch(/^[0-9a-f]{64}$/);
	});

	it('reaches the same room from every form a learner might type', async () => {
		const expected = await roomIdForPhrase(PHRASE);
		for (const typed of [
			formatPhrase(PHRASE),
			PHRASE.toLowerCase(),
			`  ${formatPhrase(PHRASE).toLowerCase()}  `,
			PHRASE.split('').join(' ')
		]) {
			await expect(roomIdForPhrase(typed)).resolves.toBe(expected);
		}
	});

	it('separates two different phrases', async () => {
		const a = await roomIdForPhrase(mintPhrase());
		const b = await roomIdForPhrase(mintPhrase());
		expect(a).not.toBe(b);
	});

	it('refuses anything that is not a phrase', async () => {
		// A typo must not open a real, empty room: that failure is indistinguish-
		// able from a learner whose library has vanished.
		for (const junk of [
			'',
			'hello',
			PHRASE.slice(0, -1),
			`${PHRASE}7`,
			'U'.repeat(PHRASE_LENGTH)
		]) {
			await expect(roomIdForPhrase(junk)).resolves.toBeUndefined();
		}
	});
});
