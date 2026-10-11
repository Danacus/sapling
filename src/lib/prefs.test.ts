import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getThemeMode, setThemeMode } from './prefs';

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
