/**
 * What a pick is made against, besides the pool and the words — the generated
 * `Serving` (`crates/sapling-challenges`' `fits.rs`): the learned shared
 * numbers, the learner's aim, the two device facts that bound which help
 * levels exist at all, and whether a row written now carries readings. The
 * device facts are read here, once per plan, so every caller that plans or
 * refills asks with the same bounds a session would serve with.
 */

import type { Serving } from '$lib/db/generated/index';
import type { Shared } from '$lib/db/generated/index';
import { writtenWithReadings } from '$lib/romanize';
import { ttsAvailable } from '$lib/tts';
import { targetTagOf } from '$lib/text';
import type { Profile } from '$lib/types';
import { getListeningMode, getRomanizationMode } from '$lib/prefs';

export type { Serving };

/** The device half: the readings setting (an upper bound) and whether listening is possible. */
export interface DeviceServing {
	romanizationMode: Serving['romanizationMode'];
	audio: boolean;
}

/**
 * This device's bounds for the target language's tag: `off` readings shows none, `on`
 * always shows them, `adaptive` lets the pick decide; listening needs the
 * learner to want it and the device to be able to speak the language.
 */
export function deviceServing(tag: string | undefined): DeviceServing {
	return {
		romanizationMode: getRomanizationMode(),
		audio: getListeningMode() && ttsAvailable(tag)
	};
}

/**
 * The whole `Serving` for one plan. `readings` is the language's, not the
 * device's: a row written for a language with a non-Latin script carries a
 * reading, so the readings setting decides which levels the writer may solve
 * a length against — with readings off, only the hidden ones.
 */
export function servingFor(
	profile: Pick<Profile, 'aim' | 'targetLanguage' | 'targetLanguageTag'> | undefined,
	parts: Shared,
	device: DeviceServing = deviceServing(targetTagOf(profile))
): Serving {
	return {
		parts,
		aim: profile?.aim ?? 'normal',
		...device,
		readings: writtenWithReadings(targetTagOf(profile))
	};
}
