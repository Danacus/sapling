//! The pairing phrase — the whole of a learner's sync identity.
//!
//! There are no accounts. The Worker hashes the phrase to pick the room, so
//! possessing it *is* the authorisation, and this module has two jobs it must
//! do exactly right:
//!
//! - **Mint enough entropy.** 20 characters over 32 symbols is 100 bits; a
//!   guess is an online guess against Cloudflare, not an offline one.
//! - **Normalise identically everywhere.** The phrase is typed by a human on
//!   the second device, so it has to survive case, spacing and the
//!   digit/letter confusions. `worker/phrase.ts` restates [`normalize`] and
//!   [`is_valid`] for the Worker, and `fixtures/phrases.json` pins the two
//!   together: normalisations that disagree by one character are two rooms,
//!   and the failure looks like an empty library rather than an error.
//!
//! The alphabet is Crockford base32 — `I`, `L`, `O` and `U` left out. The first
//! three fold into the digits they are mistaken for; `U` is never minted, so a
//! phrase holding one is a typo and is refused.

/// Crockford base32: 10 digits + 22 letters, minus `I`, `L`, `O`, `U`.
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// Characters in a minted phrase. 20 × 5 bits = 100 bits of entropy.
pub const PHRASE_LENGTH: usize = 20;

/// Characters per dash-separated group in the displayed form.
const GROUP_SIZE: usize = 5;

/// Learner-facing, for a phrase [`is_valid`] refuses.
pub const BAD_PHRASE: &str = "That does not look like a pairing phrase.";

/// The canonical form of anything a learner might type or paste: upper-cased
/// (full Unicode case mapping, as JavaScript's `toUpperCase`), everything but
/// `0-9A-Z` dropped, then `I`/`L` read as `1` and `O` as `0`. Idempotent.
pub fn normalize(raw: &str) -> String {
    raw.to_uppercase()
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| match c {
            'I' | 'L' => '1',
            'O' => '0',
            c => c,
        })
        .collect()
}

/// Whether a *normalised* phrase is one this app could have minted. Strict
/// about length: phrases are machine-minted, so a wrong length is a
/// transcription error, better caught at the input than as an empty room.
pub fn is_valid(phrase: &str) -> bool {
    phrase.len() == PHRASE_LENGTH && phrase.bytes().all(|b| ALPHABET.contains(&b))
}

/// A fresh phrase, in canonical form, from the host's random bytes. 256 is a
/// multiple of 32, so `byte % 32` is unbiased.
pub fn mint(entropy: &[u8; PHRASE_LENGTH]) -> String {
    entropy
        .iter()
        .map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()] as char)
        .collect()
}

/// The canonical phrase as a human reads it: `ABCDE-FGHJK-MNPQR-STVWX`.
/// Display only — everything stored, sent and hashed is the canonical form.
pub fn format(phrase: &str) -> String {
    let chars: Vec<char> = phrase.chars().collect();
    chars
        .chunks(GROUP_SIZE)
        .map(|group| group.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use std::collections::HashSet;

    #[derive(Deserialize)]
    struct Case {
        raw: String,
        normalized: String,
        valid: bool,
    }

    #[derive(Deserialize)]
    struct Fixture {
        cases: Vec<Case>,
    }

    /// The same file `worker/phrase.test.ts` runs against the Worker's copy.
    #[test]
    fn the_shared_fixture_holds() {
        let fixture: Fixture =
            serde_json::from_str(include_str!("../fixtures/phrases.json")).expect("fixture");
        assert!(fixture.cases.len() > 10);
        for case in fixture.cases {
            let normalized = normalize(&case.raw);
            assert_eq!(normalized, case.normalized, "normalize({:?})", case.raw);
            assert_eq!(
                is_valid(&normalized),
                case.valid,
                "is_valid({normalized:?})"
            );
        }
    }

    fn entropy(seed: u8) -> [u8; PHRASE_LENGTH] {
        std::array::from_fn(|i| {
            seed.wrapping_mul(31)
                .wrapping_add((i as u8).wrapping_mul(97))
        })
    }

    #[test]
    fn a_minted_phrase_survives_its_display_form() {
        let phrase = mint(&entropy(7));
        assert!(is_valid(&phrase));
        assert_eq!(normalize(&format(&phrase)), phrase);
        assert_eq!(normalize(&format(&phrase).to_lowercase()), phrase);
    }

    #[test]
    fn minting_uses_the_whole_alphabet() {
        let seen: HashSet<char> = (0..=255u8)
            .flat_map(|seed| mint(&[seed; PHRASE_LENGTH]).chars().collect::<Vec<_>>())
            .collect();
        assert_eq!(seen.len(), 32);
        assert!(!seen.iter().any(|c| "ILOU".contains(*c)));
    }

    #[test]
    fn the_display_form_is_not_itself_valid() {
        // Callers normalise first; the dashes never become part of a room name.
        assert!(!is_valid(&format(&mint(&entropy(3)))));
    }

    #[test]
    fn format_groups_in_fives() {
        assert_eq!(format("ABCDEFGHJKMNPQRSTVWX"), "ABCDE-FGHJK-MNPQR-STVWX");
    }
}
