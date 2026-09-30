/**
 * What a pick is made against, besides the pool and the words — the generated
 * `Serving` (`crates/sapling-challenges`' `fits.rs`): the learned shared
 * numbers, the learner's aim, and the two device facts that bound which help
 * levels exist at all. Those two are read here, once per plan, so every caller
 * that plans or refills asks with the same bounds a session would serve with.
 */

import type { Serving } from '$lib/db/generated/index';
import type { Shared } from '$lib/db/generated/index';
import { ttsAvailable } from '$lib/tts';
import type { Profile } from '$lib/types';
import { getListeningMode, getRomanizationMode } from '$lib/ui/prefs';

export type { Serving };

/** The device half: the readings setting (an upper bound) and whether listening is possible. */
export interface DeviceServing {
	romanizationMode: Serving['romanizationMode'];
	audio: boolean;
}

/**
 * This device's bounds for `targetLanguage`: `off` readings shows none, `on`
 * always shows them, `adaptive` lets the pick decide; listening needs the
 * learner to want it and the device to be able to speak the language.
 */
export function deviceServing(targetLanguage: string): DeviceServing {
	return {
		romanizationMode: getRomanizationMode(),
		audio: getListeningMode() && ttsAvailable(targetLanguage)
	};
}

/** The whole `Serving` for one plan. */
export function servingFor(
	profile: Pick<Profile, 'aim' | 'targetLanguage'> | undefined,
	parts: Shared,
	device: DeviceServing = deviceServing(profile?.targetLanguage ?? '')
): Serving {
	return { parts, aim: profile?.aim ?? 'normal', ...device };
}
