/**
 * Keyboard decisions for the two "pick one of N, then commit" challenge types.
 *
 * Multiple choice and spot-the-error present the same bargain to a keyboard
 * user — a digit picks an option, Enter commits, and picking never commits by
 * itself, so a mistyped digit is always recoverable. They had grown two
 * independent `onkeydown` handlers that agreed by coincidence rather than by
 * construction.
 *
 * This module decides; the component acts. That split is what makes the rule
 * testable in node: the input is a plain {@link KeyChord} (a `KeyboardEvent` is
 * structurally one), the output is a value, and `preventDefault` is the
 * caller's business — which also preserves the original behaviour exactly, since
 * both components suppressed the default only on a key they actually consumed.
 */

/** The subset of a `KeyboardEvent` the decision reads. */
export interface KeyChord {
	key: string;
	metaKey: boolean;
	ctrlKey: boolean;
	altKey: boolean;
}

export interface ChoiceKeyState {
	/**
	 * How many options a digit may reach. Digits above it are ignored rather
	 * than clamped — `5` in a four-option challenge is a typo, not a choice.
	 * Callers cap this themselves where the widget wants a smaller ceiling than
	 * its option count (spot-error stops at 9, there being no `10` key).
	 */
	count: number;
	/** The component has committed; the keyboard is dead until the next challenge. */
	locked: boolean;
	/** Something is selected, so Enter has something to submit. */
	hasSelection: boolean;
}

/** What the component should do about a key press. */
export type ChoiceKeyAction =
	{ kind: 'ignore' } | { kind: 'select'; index: number } | { kind: 'submit' };

const IGNORE: ChoiceKeyAction = { kind: 'ignore' };

/**
 * Maps one key press to an action.
 *
 * `ignore` means "this was not ours" — the caller must leave the event alone,
 * default and all, so browser and OS shortcuts keep working. Modified presses
 * (⌘/Ctrl/Alt) are always ignored for the same reason; Shift is not checked,
 * because no shifted digit reaches this and Shift+Enter is not a chord either
 * component ever claimed.
 */
export function choiceKeyAction(event: KeyChord, state: ChoiceKeyState): ChoiceKeyAction {
	if (state.locked || event.metaKey || event.ctrlKey || event.altKey) return IGNORE;

	const digit = Number.parseInt(event.key, 10);
	if (digit >= 1 && digit <= state.count) return { kind: 'select', index: digit - 1 };

	if (event.key === 'Enter' && state.hasSelection) return { kind: 'submit' };

	return IGNORE;
}
