/**
 * Taal: the learner's study time, sent to their Taal challenge (a friends'
 * leaderboard of minutes studied). An external, optional service like sync —
 * off until a connect code is pasted in Settings, and never in gameplay's way.
 *
 * The client is `crates/sapling-taal`, reached through `core.ts`; what stays
 * here is the device's configuration (`config.ts`) and when to push (`run.ts`).
 * What is sent is the core's `studySessions` read for the active profile.
 */
export {
	clearTaalCode,
	getTaalCode,
	lastTaalOutcome,
	setTaalCode,
	type TaalRecord
} from './config';
export { BAD_CODE, isTaalCode, REFUSED } from './core';
export { pushTaal, type TaalRun } from './run';
