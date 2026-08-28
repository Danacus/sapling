import { describe, expect, it } from 'vitest';

import { appendDictation } from './compose';

describe('appendDictation', () => {
	it('is the transcript alone when the composer is empty', () => {
		expect(appendDictation('', 'nǐ hǎo')).toBe('nǐ hǎo');
		expect(appendDictation('   ', '你好')).toBe('你好');
	});

	it('writes Han flush against what is already there', () => {
		expect(appendDictation('我想要', '一杯咖啡')).toBe('我想要一杯咖啡');
	});

	it('spaces scripts that space their words', () => {
		expect(appendDictation('I would like', 'a coffee')).toBe('I would like a coffee');
	});

	it('lets the script decide, not the whitespace the learner left', () => {
		expect(appendDictation('我想要 ', '一杯咖啡')).toBe('我想要一杯咖啡');
		expect(appendDictation('I would like ', 'a coffee')).toBe('I would like a coffee');
	});

	it('leaves the composer alone on an empty transcript', () => {
		// Every interim result re-splices from the same base, so this is the
		// "heard nothing yet" case and it must not eat what was typed.
		expect(appendDictation('我想要 ', '')).toBe('我想要 ');
		expect(appendDictation('hello', '   ')).toBe('hello');
	});
});
