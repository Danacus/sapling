/**
 * Joining a device to a library that already exists.
 *
 * A second device has no profile, so the layout would send it to onboarding and
 * onboarding would write a fresh `profileUpdated` — last-write-wins, so the
 * learner's real profile would be overwritten on every device they own. The way
 * out is to pull *before* writing anything: adopt the phrase, sync once, and
 * look for a profile that came down the log.
 *
 * This never calls `saveProfile`. Pairing only ever reads.
 */
import { getProfile } from '$lib/db/repositories';
import { setSyncEnabled, setSyncPhrase } from './config';
import { runSync } from './run';

/** What a pairing attempt did. `paired` means a profile arrived from the log. */
export interface PairOutcome {
	ok: boolean;
	/** A profile is now present locally, so this device has a library. */
	paired: boolean;
	/** Learner-facing; present on failure. */
	message?: string;
}

/** Same wording as Settings, so a rejected phrase reads the same everywhere. */
const BAD_PHRASE = 'That does not look like a pairing phrase.';

/**
 * Adopts `raw` as this device's phrase, syncs once, and reports whether a
 * profile came with it. An invalid phrase stores nothing.
 */
export async function pairDevice(
	raw: string,
	fetchImpl: typeof fetch = fetch
): Promise<PairOutcome> {
	if (setSyncPhrase(raw) === undefined) return { ok: false, paired: false, message: BAD_PHRASE };
	setSyncEnabled(true);

	const outcome = await runSync(fetchImpl);
	if (!outcome.ok) {
		return { ok: false, paired: false, message: outcome.message ?? 'Could not sync this device.' };
	}

	return { ok: true, paired: (await getProfile()) !== undefined };
}
