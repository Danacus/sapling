import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getOcrModelSize, getThemeMode, setOcrModelSize, setThemeMode } from './prefs';

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

describe('theme preference', () => {
	it('defaults to the system appearance', () => {
		expect(getThemeMode()).toBe('system');
	});

	it('round-trips each supported choice', () => {
		for (const mode of ['light', 'dark', 'system'] as const) {
			setThemeMode(mode);
			expect(getThemeMode()).toBe(mode);
		}
	});

	it('ignores corrupted and unsupported choices', () => {
		localStorage.setItem('ll.themeMode', 'sepia');
		expect(getThemeMode()).toBe('system');
		setThemeMode('dark');
		setThemeMode('neon' as never);
		expect(getThemeMode()).toBe('dark');
	});

	it('is safe when storage is unavailable', () => {
		delete globals.localStorage;
		expect(getThemeMode()).toBe('system');
		expect(() => setThemeMode('dark')).not.toThrow();
	});
});

describe('OCR model size preference', () => {
	it('defaults to the fast model', () => {
		expect(getOcrModelSize()).toBe('mobile');
	});

	it('defaults to the accurate model on a Tauri host, which runs it natively', () => {
		const host = globalThis as { window?: object };
		host.window = { __TAURI_INTERNALS__: {} };
		try {
			expect(getOcrModelSize()).toBe('server');
			setOcrModelSize('mobile');
			expect(getOcrModelSize()).toBe('mobile');
		} finally {
			delete host.window;
		}
	});

	it('round-trips both sizes', () => {
		setOcrModelSize('server');
		expect(getOcrModelSize()).toBe('server');
		setOcrModelSize('mobile');
		expect(getOcrModelSize()).toBe('mobile');
	});

	it('ignores unsupported values and missing storage', () => {
		localStorage.setItem('ll.ocrModelSize', 'huge');
		expect(getOcrModelSize()).toBe('mobile');
		setOcrModelSize('huge' as never);
		expect(localStorage.getItem('ll.ocrModelSize')).toBe('huge');
		delete globals.localStorage;
		expect(getOcrModelSize()).toBe('mobile');
		expect(() => setOcrModelSize('server')).not.toThrow();
	});
});
