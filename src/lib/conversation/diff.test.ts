/**
 * The alignment the learner's bubble is marked up from. What matters is that
 * the spans read in order and that an unchanged message produces no markup at
 * all — a correction that shows nothing would be worse than no correction.
 */

import { describe, expect, it } from 'vitest';

import {
	alignedForm,
	correctionSpans,
	diffCorrection,
	hasChanges,
	sameRomanization,
	spanGap
} from './diff';

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

describe('diffCorrection on a script written without spaces', () => {
	it('marks the one wrong character, not the whole sentence', () => {
		expect(diffCorrection('我要什么咖啡', '我有什么咖啡')).toEqual([
			{ kind: 'same', text: '我' },
			{ kind: 'removed', text: '要' },
			{ kind: 'added', text: '有' },
			{ kind: 'same', text: '什么咖啡' }
		]);
	});

	it('joins characters without inventing spaces', () => {
		const spans = diffCorrection('我喜欢咖啡', '我喜欢茶');
		expect(spans).toEqual([
			{ kind: 'same', text: '我喜欢' },
			{ kind: 'removed', text: '咖啡' },
			{ kind: 'added', text: '茶' }
		]);
	});

	it('marks a missing character as an insertion', () => {
		expect(diffCorrection('我咖啡', '我要咖啡')).toEqual([
			{ kind: 'same', text: '我' },
			{ kind: 'added', text: '要' },
			{ kind: 'same', text: '咖啡' }
		]);
	});

	it('marks Japanese kana at the character it went wrong', () => {
		expect(diffCorrection('コーヒをください', 'コーヒーをください')).toEqual([
			{ kind: 'same', text: 'コーヒ' },
			{ kind: 'added', text: 'ー' },
			{ kind: 'same', text: 'をください' }
		]);
	});

	it('keeps a Latin word inside a mixed message whole', () => {
		expect(diffCorrection('我要coffe', '我要coffee')).toEqual([
			{ kind: 'same', text: '我要' },
			{ kind: 'removed', text: 'coffe' },
			{ kind: 'added', text: 'coffee' }
		]);
	});

	it('still splits a Latin-script message on spaces, not characters', () => {
		expect(diffCorrection('ik wilt een ijsje', 'ik wil een ijsje')).toEqual([
			{ kind: 'same', text: 'ik' },
			{ kind: 'removed', text: 'wilt' },
			{ kind: 'added', text: 'wil' },
			{ kind: 'same', text: 'een ijsje' }
		]);
	});

	it('spaces Korean like a Latin script, because Korean spaces its words', () => {
		expect(diffCorrection('저는 학생 이에요', '저는 학생이에요')).toEqual([
			{ kind: 'same', text: '저는' },
			{ kind: 'removed', text: '학생 이에요' },
			{ kind: 'added', text: '학생이에요' }
		]);
	});
});

describe('spanGap', () => {
	it('spaces two Latin spans', () => {
		expect(spanGap('ik wil', 'een')).toBe(' ');
	});

	it('leaves no gap where either side is written without spaces', () => {
		expect(spanGap('我', '要')).toBe('');
		expect(spanGap('coffee', '？')).toBe(' ');
		expect(spanGap('我要', 'coffee')).toBe('');
	});

	it('handles an empty side', () => {
		expect(spanGap('', 'ik')).toBe(' ');
	});
});
