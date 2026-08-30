/**
 * Turning a pairing phrase into the name of a Durable Object.
 *
 * This is the whole of the access-control model, so it is worth being explicit
 * about what it does and does not buy.
 *
 * A room is named by `SHA-256(phrase)`. The hash is what reaches Cloudflare's
 * `idFromName`, so the phrase itself is never a room name, and a request that
 * cannot produce the phrase cannot name the room. The check is *stateless* —
 * there is no user table, no registration, nothing to keep in sync — because
 * the name is derived from the secret rather than looked up against it. A guess
 * is an online guess against Cloudflare at 100 bits; there is nothing to attack
 * offline.
 *
 * What it does not buy: the phrase travels as a bearer token, and TLS covers
 * it in transit, but it may still appear in request logs. That is the reason
 * the room name is a hash rather than the phrase itself, and the reason
 * end-to-end encryption would still be a real improvement if this were ever
 * more than one learner's own devices.
 *
 * {@link normalizePhrase} is imported from the client rather than reimplemented
 * here. Two copies that disagreed by one character would be two different
 * rooms, and the symptom — an empty library on the second device — looks like
 * data loss rather than a mismatch.
 */
import { isValidPhrase, normalizePhrase } from '../src/lib/sync/phrase';

/**
 * Domain separation, and a version marker.
 *
 * Pinning the derivation means a future change to it has to be a deliberate
 * edit here rather than an accident somewhere else, and bumping the `v1` would
 * move every learner to a new room — which is exactly the visible, breaking
 * signal such a change should be.
 */
const DERIVATION_PREFIX = 'sapling:sync:v1:';

/**
 * The room a phrase names, or `undefined` if it is not a phrase at all.
 *
 * Rejecting malformed input here rather than hashing it anyway matters: a typo
 * that still hashed would open a real, empty room and look exactly like a
 * learner whose library had vanished.
 */
export async function roomIdForPhrase(raw: string): Promise<string | undefined> {
	const phrase = normalizePhrase(raw);
	if (!isValidPhrase(phrase)) return undefined;

	const bytes = new TextEncoder().encode(DERIVATION_PREFIX + phrase);
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
