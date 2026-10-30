//! The calibration command's report for the ratings prototype (`ratings.rs`):
//! the same prequential replay as the other models, every rating at the end
//! of the log, and a table against the first model and round two's.

use std::fmt::Write;

use crate::research::calibrate_v2::{first_model, table, Model, Predict};
use crate::research::model_v2::{evaluate, score, Config, Length, Memory, ModelV2, Parts};
use crate::research::ratings::{Key, Ratings, Settings, WordSource};
use crate::research::ratings_extras::Extras;
use crate::research::v1::Observation;

const DAY: f64 = 86_400_000.0;

/// Replays the answers in order, predicting each before learning from it.
pub fn replay(log: &[Observation], settings: Settings) -> (Ratings, Vec<(f64, f64)>) {
    let mut ratings = Ratings::new(settings);
    let pairs = log.iter().map(|o| (ratings.learn(o), o.outcome)).collect();
    (ratings, pairs)
}

fn rated(settings: Settings) -> Model {
    Box::new(move |log| replay(log, settings).1)
}

fn v2(config: Config, rows: bool) -> Model {
    Box::new(move |log| {
        let mut model = ModelV2::new(config);
        log.iter()
            .map(|o| {
                let mut o = o.clone();
                if !rows {
                    o.challenge_id.clear();
                }
                (model.learn(&o), o.outcome)
            })
            .collect()
    })
}

/// The models the comparison scores: the first, round two's, the ratings
/// with each word source, each extra on its own, and round two's model cut
/// down to the ratings' shape with and without joint uncertainty — what
/// joint buys, as near as that model can show it.
pub fn models() -> Vec<(&'static str, Model)> {
    let bare = Settings::default();
    let words = |words| Settings { words, ..bare };
    let extra = |extras| Settings { extras, ..bare };
    let none = Extras::default();
    let bare_like = Config {
        parts: Parts::Flat,
        length: Length::Off,
        memory: Memory::Off,
        part_forget: 180.0,
        ..Config::FIRST
    };
    vec![
        ("current", Box::new(first_model) as Model),
        ("round 2", v2(Config::default(), true)),
        ("bare (a) own", rated(bare)),
        ("bare (b) stability", rated(words(WordSource::Stability))),
        ("bare (c) both", rated(words(WordSource::StabilityAndOwn))),
        (
            "+length",
            rated(extra(Extras {
                length: true,
                ..none
            })),
        ),
        ("+row", rated(extra(Extras { row: true, ..none }))),
        (
            "+memory",
            rated(extra(Extras {
                memory: true,
                ..none
            })),
        ),
        (
            "+ordered",
            rated(extra(Extras {
                ordered: true,
                ..none
            })),
        ),
        ("v2 bare-like", v2(bare_like, false)),
        (
            "v2 bare-like joint",
            v2(
                Config {
                    joint: true,
                    ..bare_like
                },
                false,
            ),
        ),
    ]
}

pub fn comparison(logs: &[Vec<Observation>]) -> String {
    let models = models();
    let rows: Vec<(&str, Predict)> = models.iter().map(|(n, f)| (*n, f.as_ref())).collect();
    table(logs, &rows)
}

/// The grid `--search` tries for the few free numbers.
pub const WORD_STARTS: [f64; 6] = [-0.5, 0.0, 0.5, 1.0, 1.5, 2.0];
pub const WORD_MARGINS: [f64; 4] = [0.25, 0.5, 1.0, 1.5];
pub const CHALLENGE_MARGINS: [f64; 4] = [0.5, 1.0, 1.5, 2.0];
pub const WIDENS: [f64; 4] = [0.0, 0.005, 0.02, 0.05];

/// The grid point with the lowest mean log loss over several logs.
pub fn search(logs: &[Vec<Observation>], base: Settings) -> (Settings, f64) {
    let mut best: Option<(Settings, f64)> = None;
    for word_start in WORD_STARTS {
        for word_margin in WORD_MARGINS {
            for challenge_margin in CHALLENGE_MARGINS {
                for widen in WIDENS {
                    let settings = Settings {
                        word_start,
                        word_margin,
                        challenge_margin,
                        widen,
                        ..base
                    };
                    let loss = logs
                        .iter()
                        .map(|log| score(&replay(log, settings).1).log_loss)
                        .sum::<f64>()
                        / logs.len().max(1) as f64;
                    if best.is_none_or(|(_, l)| loss < l) {
                        best = Some((settings, loss));
                    }
                }
            }
        }
    }
    best.expect("a non-empty grid")
}

/// Scores, bands, and every rating but the words' at the end of the log.
pub fn report(log: &[Observation], settings: Settings) -> String {
    let (ratings, pairs) = replay(log, settings);
    let s = score(&pairs);
    let first = score(&first_model(log));
    let (_, r2) = evaluate(log, Config::default());
    let mut out = String::new();
    let _ = writeln!(out, "ratings: {settings:?}");
    let _ = writeln!(
        out,
        "answers {} · log loss {:.4} · Brier {:.4}  (first model {:.4} / {:.4}, round 2 {:.4} / {:.4})",
        s.answers, s.log_loss, s.brier, first.log_loss, first.brier, r2.log_loss, r2.brier
    );
    let _ = writeln!(out);
    let _ = writeln!(out, "predicted     answers  mean predicted  actually right");
    for b in &s.bands {
        let _ = writeln!(
            out,
            "{:>3.0}–{:<3.0}%  {:>9}  {:>13.1}%  {:>13.1}%",
            b.from * 100.0,
            b.to * 100.0,
            b.answers,
            b.predicted * 100.0,
            b.actual * 100.0
        );
    }
    let end = log.iter().map(|o| o.at).fold(f64::MIN, f64::max);
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "{:<34} {:>7} {:>7} {:>8} {:>9}",
        "rating", "value", "margin", "answers", "last (d)"
    );
    let mut words: Vec<f64> = Vec::new();
    for (key, r) in ratings.all() {
        let name = match key {
            Key::Word(_) => {
                words.push(r.value);
                continue;
            }
            Key::Extra(name) if name.starts_with("row/") => continue,
            Key::Challenge(k) => k.clone(),
            Key::Scale => "stability scale".to_owned(),
            Key::Base => "stability base".to_owned(),
            Key::Extra(name) => name.clone(),
        };
        let now = ratings.rating(key, (r.value, r.start_margin), end);
        let _ = writeln!(
            out,
            "{name:<34} {:>7.2} {:>7.2} {:>8} {:>9.1}",
            r.value,
            now.margin,
            r.answers,
            (end - r.at) / DAY
        );
    }
    if !words.is_empty() {
        let mean = words.iter().sum::<f64>() / words.len() as f64;
        let sd =
            (words.iter().map(|w| (w - mean).powi(2)).sum::<f64>() / words.len() as f64).sqrt();
        let _ = writeln!(
            out,
            "words: {}, mean {mean:.2}, spread {sd:.2}",
            words.len()
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::{input_from_events, observations, parse_export};
    use crate::research::sim::{simulate, SimOptions};
    use sapling_domain::events::PROFILE_ID;

    #[test]
    fn every_model_scores_and_the_report_lists_the_ratings() {
        let sim = simulate(SimOptions {
            days: 20,
            ..SimOptions::default()
        });
        let seen = observations(&input_from_events(
            &parse_export(&sim.export_json()).unwrap(),
            PROFILE_ID,
        ));
        let text = comparison(std::slice::from_ref(&seen));
        assert_eq!(text.lines().count(), 1 + models().len());
        let report = report(&seen, Settings::default());
        assert!(report.contains("cloze/pick-4") && report.contains("words:"));
        let (_, pairs) = replay(&seen, Settings::default());
        assert!(score(&pairs).log_loss < 0.69);
    }
}
