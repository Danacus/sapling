/**
 * The file the learner picked, for as long as the tab is open.
 *
 * **Nothing but the name is ever stored.** A subtitled text's recording is
 * routinely hundreds of megabytes; the events log syncs to every paired device
 * and OPFS is the learner's own disk quota, so a video belongs in neither. What
 * `ReadingText.media` keeps is the file's *name*, which is enough to ask "is
 * this the one?" — and the answer to that question is a `File` handle the
 * browser will only ever give us from a picker the learner clicked.
 *
 * That leaves one gap worth closing: the open straight after an import. The
 * learner has just chosen the file in the composer, and asking for it again two
 * seconds later on the reader would read as the app not paying attention. So a
 * module-level `Map` remembers it across that one navigation — a session cache,
 * not persistence: it is a plain in-memory map, it dies with the tab, and every
 * later open shows the picker. Deliberately not `sessionStorage` (a `File` does
 * not serialise) and deliberately not the store.
 *
 * Stateless in the sense the rule means — nothing here imports `$lib/db` and
 * nothing here is a fact about the learner. The map is a cache of a handle the
 * OS owns.
 */

/** Files handed over this session, by the text they were chosen for. */
const chosen = new Map<string, File>();

/**
 * Remembers `file` as the recording for `textId`, replacing whatever was there.
 *
 * Called by the composer at import and by the reader when the learner picks the
 * file again, so a second open in the same session does not ask twice.
 */
export function rememberFile(textId: string, file: File): void {
	chosen.set(textId, file);
}

/**
 * The file remembered for `textId`, if this session has one.
 *
 * A read, not a take: the reader may mount twice for the same text (a page
 * turn, a hot reload) and losing the handle on the first mount would send the
 * learner back to the picker for no reason. Forgetting is
 * {@link forgetFile}'s job and belongs to deletion.
 */
export function takeFile(textId: string): File | undefined {
	return chosen.get(textId);
}

/** Drops the handle for a text — for when the text itself goes. */
export function forgetFile(textId: string): void {
	chosen.delete(textId);
}

/**
 * An object URL for `file`, paired with the revoke that has to follow it.
 *
 * Returned together because they are one thing: an object URL pins the file in
 * memory until it is revoked, and a reader that created one per pick without
 * revoking would hold every video the learner had tried this session. The
 * caller keeps the revoke and runs it on destroy and before every replacement.
 */
export function objectUrl(file: File): { url: string; revoke: () => void } {
	const url = URL.createObjectURL(file);
	return { url, revoke: () => URL.revokeObjectURL(url) };
}
