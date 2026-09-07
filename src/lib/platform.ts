/**
 * Which host the app is running in.
 *
 * Exactly one question — "is this the Tauri desktop shell?" — with one
 * implementation, because the answer decides several unrelated things (which
 * `Backend` transport `db/backend.ts` opens, which voice `tts/tts.ts` speaks
 * through, which host `media/youtube-host.ts` frames the player in, and
 * whether Settings shows the native-voice row) and a second copy of the test
 * would eventually disagree with the first. Each area asks it at its own seam.
 *
 * The check is deliberately a property on `window` rather than a build-time
 * flag: there is one bundle, and the *same* build is served by `vite dev`, by
 * Cloudflare Pages and from `tauri://localhost`. Tauri injects
 * `__TAURI_INTERNALS__` before any app code runs, so this is true from the
 * first module evaluation onwards and never changes afterwards.
 *
 * Callers must keep everything host-specific behind a **dynamic** import gated
 * on this, so a browser never fetches the chunk — see `db/tauri.ts` and
 * `tts/native.ts`, neither of which the web bundle loads.
 */
export function inTauri(): boolean {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}
