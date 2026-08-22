import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
	DEFAULT_TTS_DEVICE,
	DEFAULT_TTS_ENGINE,
	getTtsDevice,
	getTtsEngine,
	setTtsDevice,
	setTtsEngine
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

describe('tts device preference', () => {
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
