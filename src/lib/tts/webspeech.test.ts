import { describe, expect, it } from 'vitest';

import { pickVoice } from './webspeech';

const voices = [
	{ lang: 'en-US', name: 'Alex' },
	{ lang: 'pt-PT', name: 'Joana' },
	{ lang: 'pt-BR', name: 'Luciana' },
	{ lang: 'nl-NL', name: 'Xander' }
];

describe('pickVoice', () => {
	it('prefers an exact tag match', () => {
		expect(pickVoice(voices, 'pt-BR')?.name).toBe('Luciana');
	});

	it('falls back to any voice for the same base language', () => {
		expect(pickVoice(voices, 'pt')?.name).toBe('Joana');
		expect(pickVoice(voices, 'nl-BE')?.name).toBe('Xander');
	});

	it('ignores case and underscore-style tags', () => {
		expect(pickVoice(voices, 'pt_br')?.name).toBe('Luciana');
		expect(pickVoice([{ lang: 'zh_CN', name: 'Ting' }], 'zh-CN')?.name).toBe('Ting');
	});

	it('returns undefined when nothing matches, leaving the browser its default', () => {
		expect(pickVoice(voices, 'ja')).toBeUndefined();
		expect(pickVoice([], 'en')).toBeUndefined();
	});
});
