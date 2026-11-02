/**
 * A text's recordings: at most one YouTube link and one file, the same
 * recording both. The list is the store's (`textMediaSet` replaces it whole);
 * which one plays is this device's choice, remembered per text in
 * `localStorage` as a convenience only. YouTube plays by default, since it
 * needs nothing from the learner on any device.
 */
import type { ReadingMedia } from '$lib/types';

export type FileMedia = Extract<ReadingMedia, { kind: 'file' }>;
export type RecordingKind = ReadingMedia['kind'];

/** The YouTube video id among `media`, if there is one. */
export function youtubeOf(media: readonly ReadingMedia[] | undefined): string | undefined {
	const found = media?.find((m) => m.kind === 'youtube');
	return found?.kind === 'youtube' ? found.videoId : undefined;
}

/** The file reference among `media`, if there is one. */
export function fileOf(media: readonly ReadingMedia[] | undefined): FileMedia | undefined {
	const found = media?.find((m) => m.kind === 'file');
	return found?.kind === 'file' ? found : undefined;
}

/** The reference a picked file is stored as: its name and, when offered, its type. */
export function fileMedia(file: Pick<File, 'name' | 'type'>): FileMedia {
	return { kind: 'file', name: file.name, ...(file.type ? { type: file.type } : {}) };
}

/** The list from what there is of each kind, YouTube first. */
export function recordingsOf(
	youtube: string | undefined,
	file: FileMedia | undefined
): ReadingMedia[] {
	return [
		...(youtube ? [{ kind: 'youtube', videoId: youtube } as const] : []),
		...(file ? [file] : [])
	];
}

/** Which recording plays: the file only when there is one and the switch asks for it. */
export function playing(
	media: readonly ReadingMedia[] | undefined,
	preferFile: boolean
): RecordingKind | undefined {
	const youtube = youtubeOf(media) !== undefined;
	const file = fileOf(media) !== undefined;
	if (file && (preferFile || !youtube)) return 'file';
	return youtube ? 'youtube' : undefined;
}

const PLAY_FILE_KEY = 'll.playFromFile.';

/** Whether this device plays `textId` from its file. False when storage is unavailable. */
export function prefersFile(textId: string): boolean {
	try {
		return localStorage.getItem(PLAY_FILE_KEY + textId) === '1';
	} catch {
		return false;
	}
}

export function setPrefersFile(textId: string, on: boolean): void {
	try {
		if (on) localStorage.setItem(PLAY_FILE_KEY + textId, '1');
		else localStorage.removeItem(PLAY_FILE_KEY + textId);
	} catch {
		// A convenience; the default is still a sound choice.
	}
}
