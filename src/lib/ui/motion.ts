/**
 * Motion budget for every JS-driven transition — the session screen, the
 * feedback banner, the task tray.
 *
 * CSS animations are switched off with a `prefers-reduced-motion` media query
 * (see `src/app.css`), but Svelte's JS-driven transitions (`fly`, `scale`,
 * `fade`) are not covered by CSS at all — their durations are numbers we pass
 * in. This module is that one number, so every such transition collapses to
 * an instant cut for learners who asked for less movement. It lives in
 * `$lib/ui` because it is a fact about rendering: when it sat in
 * `$lib/session`, the task tray importing it tied `ui` to `session`.
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
