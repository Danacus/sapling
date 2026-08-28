/**
 * The alignment the learner's bubble is marked up from. What matters is that
 * the spans read in order and that an unchanged message produces no markup at
 * all — a correction that shows nothing would be worse than no correction.
 */

import { describe, expect, it } from 'vitest';

import { alignedForm, correctionSpans, diffCorrection, hasChanges, sameRomanization } from './diff';

describe('diffCorrection', () => {
	it('returns one unchanged span when nothing changed', () => {
		const spans = diffCorrection('ik wil een ijsje', 'ik wil een ijsje');
		expect(spans).toEqual([{ kind: 'same', text: 'ik wil een ijsje' }]);
		expect(hasChanges(spans)).toBe(false);
	});

	it('ignores whitespace differences', () => {
		expect(hasChanges(diffCorrection('  ik wil   een ijsje ', 'ik wil een ijsje'))).toBe(false);
	});

	it('marks a replaced word, removal before addition', () => {
		expect(diffCorrection('ik wilt een ijsje', 'ik wil een ijsje')).toEqual([
			{ kind: 'same', text: 'ik' },
			{ kind: 'removed', text: 'wilt' },
			{ kind: 'added', text: 'wil' },
			{ kind: 'same', text: 'een ijsje' }
		]);
	});

	it('marks two words joined into one', () => {
		expect(diffCorrection('goeden avond', 'goedenavond')).toEqual([
			{ kind: 'removed', text: 'goeden avond' },
			{ kind: 'added', text: 'goedenavond' }
		]);
	});

	it('marks an inserted word without touching its neighbours', () => {
		expect(diffCorrection('ik wil ijsje', 'ik wil een ijsje')).toEqual([
			{ kind: 'same', text: 'ik wil' },
			{ kind: 'added', text: 'een' },
			{ kind: 'same', text: 'ijsje' }
		]);
	});

	it('marks a dropped word', () => {
		expect(diffCorrection('ik wil een een ijsje', 'ik wil een ijsje')).toEqual([
			{ kind: 'same', text: 'ik wil een' },
			{ kind: 'removed', text: 'een' },
			{ kind: 'same', text: 'ijsje' }
		]);
	});

	it('degrades to a whole-message rewrite when nothing lines up', () => {
		expect(diffCorrection('quiero un helado', 'ik wil een ijsje')).toEqual([
			{ kind: 'removed', text: 'quiero un helado' },
			{ kind: 'added', text: 'ik wil een ijsje' }
		]);
	});

	it('is case-sensitive: a wrong capital is a real correction', () => {
		expect(diffCorrection('hallo', 'Hallo')).toEqual([
			{ kind: 'removed', text: 'hallo' },
			{ kind: 'added', text: 'Hallo' }
		]);
	});

	it('handles an empty side', () => {
		expect(diffCorrection('', 'ik wil een ijsje')).toEqual([
			{ kind: 'added', text: 'ik wil een ijsje' }
		]);
		expect(diffCorrection('ik wil een ijsje', '')).toEqual([
			{ kind: 'removed', text: 'ik wil een ijsje' }
		]);
	});
});

describe('alignedForm', () => {
	it('compares against the reading when the learner typed the reading', () => {
		const corrected = { text: '你有什么咖啡？', reading: 'nǐ yǒu shénme kāfēi' };
		expect(alignedForm('ni yao kafe shenme', corrected)).toBe('nǐ yǒu shénme kāfēi');
	});

	it('compares against the script when the learner typed the script', () => {
		const corrected = { text: '你有什么咖啡？', reading: 'nǐ yǒu shénme kāfēi' };
		expect(alignedForm('你要什么咖啡？', corrected)).toBe('你有什么咖啡？');
	});

	it('compares against the text for a Latin-script target', () => {
		expect(alignedForm('ik wilt een ijsje', { text: 'ik wil een ijsje' })).toBe('ik wil een ijsje');
	});

	it('falls back to the text when the correction carries no reading', () => {
		expect(alignedForm('ni yao kafe', { text: '你要咖啡' })).toBe('你要咖啡');
	});
});

describe('correctionSpans', () => {
	it('marks the syllables that were wrong, not the whole message', () => {
		const spans = correctionSpans('ni yao kafe shenme', {
			corrected: { text: '你有什么咖啡？', reading: 'nǐ yǒu shénme kāfēi' }
		});
		expect(spans.filter((span) => span.kind === 'same')).not.toHaveLength(0);
		expect(spans.map((span) => span.text).join(' ')).toContain('yao');
	});
});

describe('sameRomanization', () => {
	it('ignores tone marks, capitals and syllable spacing', () => {
		expect(sameRomanization('ni hao ma', 'Nǐ hǎo ma')).toBe(true);
		expect(sameRomanization('wo yao kafei', 'wǒ yào kā fēi')).toBe(true);
		expect(sameRomanization('konnichiwa', 'konnichi wa')).toBe(true);
		expect(sameRomanization("xi'an", 'xian')).toBe(true);
	});

	it('still sees a different word as different', () => {
		expect(sameRomanization('wo yao kafei', 'wǒ yǒu kā fēi')).toBe(false);
		expect(sameRomanization('ni hao', 'ni hao ma')).toBe(false);
	});
});

describe('correctionSpans, loosened for readings only', () => {
	it('marks nothing when only the spacing and tones differed', () => {
		const spans = correctionSpans('wo yao kafei', {
			corrected: { text: '我要咖啡', reading: 'wǒ yào kāfēi' }
		});
		expect(spans.every((span) => span.kind === 'same')).toBe(true);
	});

	it('keeps a Latin-script target strict, so an accent is still a correction', () => {
		const spans = correctionSpans('je vais a ecole', {
			corrected: { text: "je vais à l'école" }
		});
		expect(spans.some((span) => span.kind === 'removed' && span.text.includes('a'))).toBe(true);
	});
});

describe('alignedForm on a mixed-script message', () => {
	const corrected = { text: '我不是你的主理人', reading: 'wǒ bù shì nǐ de zhǔlǐrén' };

	it('follows the script the learner mostly typed', () => {
		expect(alignedForm('wo bu shi ni de 主理人', corrected)).toBe('wǒ bù shì nǐ de zhǔlǐrén');
	});

	it('still uses the script when they typed the script', () => {
		expect(alignedForm('我不是你的主理人', corrected)).toBe('我不是你的主理人');
	});
});
