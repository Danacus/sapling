//! What the bare ratings model (`ratings.rs`) leaves out, each switchable on
//! its own so `calibrate` can show what it buys (`docs/difficulty-ratings.md`
//! §6). All off is the bare model. None names a kind: every extra starts the
//! same for every kind.

use crate::help::HelpLevel;
use crate::model::{logit, tuning, Observation};
use crate::model_v2::{centre, STEP};
use crate::ratings::{Key, Ratings, Term};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Extras {
    /// A slope per kind: each word over the kind's middle length adds to it.
    pub length: bool,
    /// A correction per challenge row.
    pub row: bool,
    /// FSRS memory at answer time, with a learned weight.
    pub memory: bool,
    /// A later step in a kind's list, a hidden reading and listening start
    /// out harder (by `model_v2::STEP` per place and `data/model.json`'s
    /// `hidden` and `listening`).
    pub ordered: bool,
}

impl Extras {
    pub fn any(&self) -> bool {
        self.length || self.row || self.memory || self.ordered
    }
}

/// FSRS reads 1 within a day of a review; as a logit that is ±14.
const MEMORY_CEILING: f64 = 0.99;

impl Ratings {
    pub(crate) fn add_extras(&self, o: &Observation, terms: &mut Vec<Term>) {
        let x = self.settings.extras;
        if x.ordered {
            let steps = o.kind.written_steps();
            let place = steps.iter().position(|s| *s == o.help.step).unwrap_or(0);
            let help: HelpLevel = o.help;
            let t = tuning();
            let start = place as f64 * STEP
                + if help.reading_hidden { t.hidden } else { 0.0 }
                + if help.listening { t.listening } else { 0.0 };
            if let Some(c) = terms
                .iter_mut()
                .find(|t| matches!(t.key, Key::Challenge(_)))
            {
                c.start.0 = start;
            }
        }
        if x.length {
            terms.push(Term {
                key: Key::Extra(format!("slope/{}", o.kind.as_str())),
                weight: -(o.length - centre(o.kind)),
                start: (0.1, 0.1),
            });
        }
        if x.row && !o.challenge_id.is_empty() {
            terms.push(Term {
                key: Key::Extra(format!("row/{}", o.challenge_id)),
                weight: -1.0,
                start: (0.0, 0.5),
            });
        }
        if x.memory {
            let memory: f64 = o.words.iter().map(|w| w.memory.clamp(1e-3, 1.0)).product();
            terms.push(Term {
                key: Key::Extra("memory".into()),
                weight: logit(memory.min(MEMORY_CEILING)) - logit(tuning().new_word_memory),
                start: (0.0, 0.5),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help::Step;
    use crate::kinds::WireType;
    use crate::model::Evidence;
    use crate::ratings::Settings;

    fn answer(help: HelpLevel) -> Observation {
        Observation {
            at: 0.0,
            challenge_id: "c".into(),
            kind: WireType::Cloze,
            help,
            length: 9.0,
            words: vec![Evidence {
                item_id: "w".into(),
                memory: 0.7,
                stability: 2.0,
            }],
            outcome: 1.0,
        }
    }

    fn with(extras: Extras) -> Ratings {
        Ratings::new(Settings {
            extras,
            ..Settings::default()
        })
    }

    #[test]
    fn each_extra_adds_its_own_number_and_none_is_on_by_default() {
        let o = answer(HelpLevel::step(Step::Pick4));
        assert_eq!(Ratings::new(Settings::default()).terms(&o).len(), 2);
        assert!(!Settings::default().extras.any());
        for extras in [
            Extras {
                length: true,
                ..Extras::default()
            },
            Extras {
                row: true,
                ..Extras::default()
            },
            Extras {
                memory: true,
                ..Extras::default()
            },
        ] {
            assert_eq!(with(extras).terms(&o).len(), 3, "{extras:?}");
        }
    }

    #[test]
    fn ordered_starts_a_later_step_and_a_hidden_reading_harder() {
        let r = with(Extras {
            ordered: true,
            ..Extras::default()
        });
        let start = |help| {
            r.terms(&answer(help))
                .into_iter()
                .find(|t| matches!(t.key, Key::Challenge(_)))
                .unwrap()
                .start
                .0
        };
        let (pick4, typed) = (
            start(HelpLevel::step(Step::Pick4)),
            start(HelpLevel::step(Step::Typed)),
        );
        assert!(pick4 < typed && typed < start(HelpLevel::hidden(Step::Typed)));
    }
}
