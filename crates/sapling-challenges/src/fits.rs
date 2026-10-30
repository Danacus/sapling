//! What a pick is made against besides the pool, the words and the ratings
//! (`Serving`), and the help levels a row is shown at under it: a stored
//! row's read off the row ([`help_levels`]), a row not written yet's off its
//! kind ([`written_levels`]). The writer and serving ask the same levels, so a
//! row written now is judged on the screens it will be served at.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::help::{HelpLevel, Step};
use crate::kinds::WireType;
use crate::model::Aim;
use crate::serve::RomanizationMode;
use crate::Challenge;

/// What a pick is made against besides the pool, the words and the ratings:
/// the learner's aim, the two things that bound which help levels exist at
/// all, and whether a row written now carries readings.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Serving {
    #[serde(default)]
    pub aim: Aim,
    /// The learner's readings setting, an upper bound: `off` shows none, `on`
    /// always shows them, `adaptive` lets the pick decide.
    #[serde(default)]
    pub romanization_mode: RomanizationMode,
    /// Whether this device can speak and the learner wants listening.
    #[serde(default)]
    pub audio: bool,
    /// Whether a row written now carries readings: the target language is
    /// written in a script other than Latin, for which the lesson prompt has
    /// the model write a reading beside every target-language string. A
    /// stored row's levels are read off the row itself ([`help_levels`]);
    /// this is what a row not written yet is judged by ([`written_levels`]).
    /// Absent is `false`, a Latin-script language.
    #[serde(default)]
    pub readings: bool,
}

/// The help levels of a row with these steps, whether it carries readings and
/// whether it can be heard, under these settings, easiest first. A row with a
/// reading shows it at every step and, where the setting allows, hides it at
/// the hardest step too; `off` hides it everywhere and `on` never does.
/// Listening, where the row can be heard and the device can speak, is the
/// hardest.
fn levels(steps: &[Step], readings: bool, listen: bool, serving: &Serving) -> Vec<HelpLevel> {
    let mut levels = Vec::with_capacity(steps.len() + 2);
    for (i, step) in steps.iter().enumerate() {
        if !readings {
            levels.push(HelpLevel::step(*step));
            continue;
        }
        match serving.romanization_mode {
            RomanizationMode::On => levels.push(HelpLevel::step(*step)),
            RomanizationMode::Off => levels.push(HelpLevel::hidden(*step)),
            RomanizationMode::Adaptive => {
                levels.push(HelpLevel::step(*step));
                if i + 1 == steps.len() {
                    levels.push(HelpLevel::hidden(*step));
                }
            }
        }
    }
    if serving.audio && listen {
        levels.push(HelpLevel::LISTENING);
    }
    levels
}

/// Every help level a stored row can be shown at under these settings,
/// easiest first: its own steps, its own readings, whether it can be heard.
pub fn help_levels(challenge: &Challenge, serving: &Serving) -> Vec<HelpLevel> {
    levels(
        &challenge.steps(),
        challenge.has_readings(),
        challenge.can_listen(),
        serving,
    )
}

/// Every help level a row of `kind` written now will be shown at: the steps
/// it is written with (the resolver always writes the full bank, tray and
/// hint), a reading where the language has one, and listening where it can be
/// heard — exactly what [`help_levels`] reads off the row once it is stored.
pub fn written_levels(kind: WireType, serving: &Serving) -> Vec<HelpLevel> {
    let steps = kind.written_steps();
    levels(&steps, serving.readings, kind.can_listen(), serving)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pool::PoolRow;
    use crate::research::sim::synthetic;
    use serde_json::json;

    fn row(value: serde_json::Value) -> PoolRow {
        let mut value = value;
        value["generatedAt"] = json!(0);
        value["timesServed"] = json!(0);
        value["lastServedAt"] = json!(null);
        value["reported"] = json!(false);
        serde_json::from_value(value).unwrap()
    }

    fn cloze(reading: bool) -> PoolRow {
        let mut value = json!({ "id": "c", "type": "cloze", "direction": "toTarget",
            "sentence": "我们想___。", "acceptedAnswers": ["买单"],
            "wordBank": ["买单", "a", "b", "c", "d", "e"], "itemIds": ["w"] });
        if reading {
            value["sentenceRomanization"] = json!("Wǒmen xiǎng ___.");
        }
        row(value)
    }

    fn recognize() -> PoolRow {
        row(
            json!({ "id": "m", "type": "multiple-choice", "direction": "toNative", "prompt": "猫",
            "options": ["cat", "dog", "bird", "fish"], "correctIndex": 0, "itemIds": ["w"] }),
        )
    }

    #[test]
    fn the_readings_setting_bounds_the_help_levels() {
        let adaptive = Serving::default();
        let ids = |r: &PoolRow, s: &Serving| -> Vec<String> {
            help_levels(&r.challenge, s)
                .iter()
                .map(|h| h.id())
                .collect()
        };
        assert_eq!(
            ids(&cloze(true), &adaptive),
            ["pick-4", "pick-6", "typed", "typed-hidden"]
        );
        assert_eq!(ids(&cloze(false), &adaptive), ["pick-4", "pick-6", "typed"]);
        let off = Serving {
            romanization_mode: RomanizationMode::Off,
            ..Serving::default()
        };
        assert_eq!(
            ids(&cloze(true), &off),
            ["pick-4-hidden", "pick-6-hidden", "typed-hidden"]
        );
        let on = Serving {
            romanization_mode: RomanizationMode::On,
            ..Serving::default()
        };
        assert_eq!(ids(&cloze(true), &on), ["pick-4", "pick-6", "typed"]);
        assert_eq!(ids(&recognize(), &adaptive), ["plain"]);
        let heard = Serving {
            audio: true,
            ..Serving::default()
        };
        assert_eq!(ids(&recognize(), &heard), ["plain", "listening"]);
    }

    /// What the writer reasons over is what serving reads off the row once
    /// it is stored, for every kind and every setting.
    #[test]
    fn a_written_row_is_served_at_the_levels_it_was_written_for() {
        use crate::research::sim::with_readings;
        for readings in [false, true] {
            for mode in [
                RomanizationMode::Off,
                RomanizationMode::On,
                RomanizationMode::Adaptive,
            ] {
                for audio in [false, true] {
                    let serving = Serving {
                        readings,
                        romanization_mode: mode,
                        audio,
                        ..Serving::default()
                    };
                    for kind in crate::kinds::active_kinds() {
                        let mut value = synthetic(kind, "c", &["w", "v"], 6);
                        if readings {
                            value = with_readings(value);
                        }
                        let stored = row(value);
                        assert_eq!(
                            help_levels(&stored.challenge, &serving),
                            written_levels(kind, &serving),
                            "{kind:?} {serving:?}"
                        );
                    }
                }
            }
        }
    }
}
