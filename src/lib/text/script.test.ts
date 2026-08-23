import { describe, expect, it } from 'vitest';

import { joinTokens, usesInterWordSpaces } from './script';

describe('usesInterWordSpaces', () => {
	it('is true for the scripts that write spaces', () => {
		expect(usesInterWordSpaces('por favor')).toBe(true);
		expect(usesInterWordSpaces('пожалуйста')).toBe(true);
		expect(usesInterWordSpaces('παρακαλώ')).toBe(true);
		expect(usesInterWordSpaces('من فضلك')).toBe(true);
		// Korean spaces its words, unlike its neighbours.
		expect(usesInterWordSpaces('메뉴 주세요')).toBe(true);
	});

	it('is false for the scripts that do not', () => {
		expect(usesInterWordSpaces('菜单')).toBe(false);
		expect(usesInterWordSpaces('メニューをください')).toBe(false);
		expect(usesInterWordSpaces('ください')).toBe(false);
		expect(usesInterWordSpaces('สวัสดี')).toBe(false);
	});
});

describe('joinTokens', () => {
	it('spaces a Latin sentence and keeps punctuation attached', () => {
		expect(joinTokens(['¿Nos', 'trae', 'la', 'cuenta,', 'por', 'favor?'])).toBe(
			'¿Nos trae la cuenta, por favor?'
		);
		expect(joinTokens(['Quisiera', 'pedir', 'el', 'pescado', '.'])).toBe(
			'Quisiera pedir el pescado.'
		);
		expect(joinTokens(['¿', 'Ya', 'podemos', 'pedir', '?'])).toBe('¿Ya podemos pedir?');
	});

	it('joins a no-space script with nothing at all', () => {
		expect(joinTokens(['我们', '想', '买单'])).toBe('我们想买单');
		expect(joinTokens(['你好', '，', '请', '给', '我', '菜单', '。'])).toBe('你好，请给我菜单。');
		expect(joinTokens(['メニュー', 'を', 'ください'])).toBe('メニューをください');
	});

	it('lets one no-space token decide for the whole sentence', () => {
		// A Mandarin sentence with a loanword in it is still a Mandarin sentence.
		expect(joinTokens(['我', '要', 'WiFi'])).toBe('我要WiFi');
	});

	it('drops blanks and trims, so a half-built tray still reads', () => {
		expect(joinTokens(['  por  ', '', '   ', 'favor'])).toBe('por favor');
		expect(joinTokens([])).toBe('');
		expect(joinTokens(['   '])).toBe('');
	});
});
