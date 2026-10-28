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

const apple = (lang: string, name: string, uri: string) => ({ lang, name, voiceURI: uri });

describe('pickVoice on Safari voice lists', () => {
	const en = [
		apple('en-US', 'Albert', 'com.apple.speech.synthesis.voice.Albert'),
		apple('en-US', 'Eddy', 'com.apple.eloquence.en-US.Eddy'),
		apple('en-US', 'Samantha', 'com.apple.voice.compact.en-US.Samantha'),
		apple('en-US', 'Samantha (Enhanced)', 'com.apple.voice.enhanced.en-US.Samantha'),
		apple('en-US', 'Samantha (Premium)', 'com.apple.voice.premium.en-US.Samantha')
	];

	it('ranks premium over enhanced over compact over Eloquence over novelty', () => {
		expect(pickVoice(en, 'en-US')?.voiceURI).toBe('com.apple.voice.premium.en-US.Samantha');
		expect(pickVoice(en.slice(0, 4), 'en-US')?.name).toBe('Samantha (Enhanced)');
		expect(pickVoice(en.slice(0, 3), 'en-US')?.name).toBe('Samantha');
		expect(pickVoice(en.slice(0, 2), 'en-US')?.name).toBe('Eddy');
	});

	it('still picks a novelty voice when it is the only match', () => {
		expect(pickVoice(en.slice(0, 1), 'en')?.name).toBe('Albert');
	});

	it('ranks the Tingting variants', () => {
		const zh = [
			apple('zh-CN', 'Tingting', 'com.apple.voice.compact.zh-CN.Tingting'),
			apple('zh-CN', 'Tingting (Enhanced)', 'com.apple.voice.enhanced.zh-CN.Tingting'),
			apple('zh-TW', 'Meijia', 'com.apple.voice.premium.zh-TW.Meijia')
		];
		expect(pickVoice(zh, 'zh-CN')?.name).toBe('Tingting (Enhanced)');
	});

	it('keeps an exact tag match ahead of a better base-language voice', () => {
		const list = [
			apple('en-GB', 'Daniel (Premium)', 'com.apple.voice.premium.en-GB.Daniel'),
			apple('en-US', 'Samantha', 'com.apple.voice.compact.en-US.Samantha')
		];
		expect(pickVoice(list, 'en-US')?.name).toBe('Samantha');
		expect(pickVoice(list, 'en-AU')?.name).toBe('Daniel (Premium)');
	});

	it('keeps first-match order for non-Apple voices', () => {
		const chrome = [
			{ lang: 'en-US', name: 'Google US English', voiceURI: 'Google US English' },
			{ lang: 'en-US', name: 'Microsoft Aria', voiceURI: 'Microsoft Aria' }
		];
		expect(pickVoice(chrome, 'en-US')?.name).toBe('Google US English');
	});
});
