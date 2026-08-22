/**
 * Motion budget for the session screen.
 *
 * CSS animations are switched off with a `prefers-reduced-motion` media query
 * (see `src/app.css`), but Svelte's JS-driven transitions (`fly`, `scale`,
 * `fade`) are not covered by CSS at all — their durations are numbers we pass
 * in. This module is that one number, so every transition on the learn screen
 * collapses to an instant cut for learners who asked for less movement.
 */

/** True when the OS/browser asks for reduced motion. Safe outside the browser. */
export function prefersReducedMotion(): boolean {
	if (typeof matchMedia !== 'function') return false;
	try {
		return matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch {
		return false;
	}
}

/** `ms`, or 0 when the learner prefers reduced motion. */
export function motionMs(ms: number): number {
	return prefersReducedMotion() ? 0 : ms;
}
