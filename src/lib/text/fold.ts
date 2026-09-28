/**
 * NFD-decompose and drop combining marks, e.g. `"café"` -> `"cafe"`,
 * `"nǐ hǎo"` -> `"ni hao"` — the same folding the Rust core grades and
 * resolves with (`crates/sapling-challenges`' `text.rs`), for the local
 * romanizer and the conversation diff.
 */
export function foldDiacritics(s: string): string {
	return s.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}
