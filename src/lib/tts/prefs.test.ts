import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	DEFAULT_TTS_DEVICE,
	DEFAULT_TTS_ENGINE,
	DEFAULT_TTS_VOICE,
	getTtsDevice,
	getTtsEngine,
	getTtsVoice,
	setTtsDevice,
	setTtsEngine,
	setTtsVoice
} from './prefs';

/** Minimal in-memory `localStorage`; these tests run in the node environment. */
function fakeStorage() {
	const map = new Map<string, string>();
	return {
		getItem: (key: string) => map.get(key) ?? null,
		setItem: (key: string, value: string) => void map.set(key, value),
		removeItem: (key: string) => void map.delete(key),
		clear: () => map.clear(),
		key: (index: number) => [...map.keys()][index] ?? null,
		get length() {
			return map.size;
		}
	} as unknown as Storage;
}

const globals = globalThis as { localStorage?: Storage };

beforeEach(() => {
	globals.localStorage = fakeStorage();
});

afterEach(() => {
	delete globals.localStorage;
});

describe('tts engine preference', () => {
	it('defaults to kokoro when nothing has been chosen', () => {
		expect(getTtsEngine()).toBe('kokoro');
		expect(DEFAULT_TTS_ENGINE).toBe('kokoro');
	});

	it('round-trips every valid engine', () => {
		for (const engine of ['webspeech', 'off', 'kokoro'] as const) {
			setTtsEngine(engine);
			expect(getTtsEngine()).toBe(engine);
		}
	});

	it('reads a corrupted value as the default instead of returning junk', () => {
		localStorage.setItem('ll.ttsEngine', 'sqlite');
		expect(getTtsEngine()).toBe(DEFAULT_TTS_ENGINE);
	});

	it('refuses to store an unknown engine', () => {
		setTtsEngine('webspeech');
		setTtsEngine('nonsense' as never);
		expect(getTtsEngine()).toBe('webspeech');
	});

	it('falls back to the default with no storage at all', () => {
		delete globals.localStorage;
		expect(getTtsEngine()).toBe(DEFAULT_TTS_ENGINE);
		expect(() => setTtsEngine('off')).not.toThrow();
	});
});

describe('tts voice preference', () => {
	it('defaults to auto, meaning "let the language mapping choose"', () => {
		expect(getTtsVoice()).toBe('auto');
		expect(DEFAULT_TTS_VOICE).toBe('auto');
	});

	it('round-trips every curated Mandarin voice', () => {
		for (const voice of ['zf_001', 'zf_018', 'zm_010', 'auto'] as const) {
			setTtsVoice(voice);
			expect(getTtsVoice()).toBe(voice);
		}
	});

	it('reads a corrupted or retired voice as the default', () => {
		localStorage.setItem('ll.ttsVoice', 'af_heart');
		expect(getTtsVoice()).toBe(DEFAULT_TTS_VOICE);
	});

	it('refuses to store an unknown voice', () => {
		setTtsVoice('zm_010');
		setTtsVoice('zz_999' as never);
		expect(getTtsVoice()).toBe('zm_010');
	});

	it('falls back to the default with no storage at all', () => {
		delete globals.localStorage;
		expect(getTtsVoice()).toBe(DEFAULT_TTS_VOICE);
		expect(() => setTtsVoice('zf_018')).not.toThrow();
	});
});

// Vestigial since the move to sherpa-onnx (WASM is CPU-only); kept readable so
// an existing stored value stays inert rather than being reinterpreted.
describe('tts device preference (legacy)', () => {
	it('defaults to auto', () => {
		expect(getTtsDevice()).toBe('auto');
		expect(DEFAULT_TTS_DEVICE).toBe('auto');
	});

	it('round-trips the CPU override', () => {
		setTtsDevice('wasm');
		expect(getTtsDevice()).toBe('wasm');
		setTtsDevice('auto');
		expect(getTtsDevice()).toBe('auto');
	});

	it('reads a corrupted value as the default', () => {
		localStorage.setItem('ll.ttsDevice', 'cuda');
		expect(getTtsDevice()).toBe(DEFAULT_TTS_DEVICE);
	});
});
