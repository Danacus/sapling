//! Tuning is measured, not judged by feel: replay a log, predict every answer
//! before learning from it, and report how well the predictions matched —
//! one number (mean log loss, lower is better) and a table of predicted bands
//! against what actually happened. The `calibrate` binary prints it for an
//! export or for the simulated learner.
//!
//! Changing a rate or a starting value means running this again and comparing
//! the score. Both ways of combining several words' skills are scored every
//! time (§12.1), and `--search` tries a grid of rates around the current ones.

use std::fmt::Write;

use crate::model::{evaluate, tuning, MultiWord, Observation, Rates, Score, MULTI_WORD};

/// The rates `--search` tries, each axis around where the current ones sit.
pub const WORD_RATES: [f64; 5] = [0.1, 0.2, 0.3, 0.45, 0.6];
pub const SHARED_RATES: [f64; 4] = [0.005, 0.01, 0.02, 0.05];
pub const CHALLENGE_RATES: [f64; 4] = [0.05, 0.1, 0.2, 0.4];

#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub rates: Rates,
    pub multi: MultiWord,
    pub log_loss: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Report {
    /// The current rates and the current way of combining words.
    pub current: Score,
    pub lowest: f64,
    pub average: f64,
    /// The best of the grid, when one was searched.
    pub best: Option<Candidate>,
}

/// Always guessing the log's own success rate: the score to beat.
pub fn baseline(observations: &[Observation]) -> f64 {
    if observations.is_empty() {
        return 0.0;
    }
    let rate = (observations.iter().map(|o| o.outcome).sum::<f64>() / observations.len() as f64)
        .clamp(0.01, 0.99);
    -observations
        .iter()
        .map(|o| o.outcome * rate.ln() + (1.0 - o.outcome) * (1.0 - rate).ln())
        .sum::<f64>()
        / observations.len() as f64
}

pub fn search(observations: &[Observation]) -> Candidate {
    search_many(std::slice::from_ref(&observations.to_vec()))
}

/// The grid point with the lowest log loss averaged over several logs — how
/// the starting rates were chosen, over several simulated learners, so one
/// learner's luck does not pick them.
pub fn search_many(logs: &[Vec<Observation>]) -> Candidate {
    let mut best: Option<Candidate> = None;
    for word in WORD_RATES {
        for shared in SHARED_RATES {
            for challenge in CHALLENGE_RATES {
                for multi in [MultiWord::Lowest, MultiWord::Average] {
                    let rates = Rates {
                        word,
                        shared,
                        challenge,
                    };
                    let log_loss = logs
                        .iter()
                        .map(|log| evaluate(log, &rates, multi).1.log_loss)
                        .sum::<f64>()
                        / logs.len().max(1) as f64;
                    if best.as_ref().is_none_or(|b| log_loss < b.log_loss) {
                        best = Some(Candidate {
                            rates,
                            multi,
                            log_loss,
                        });
                    }
                }
            }
        }
    }
    best.expect("a non-empty grid")
}

pub fn calibrate(observations: &[Observation], with_search: bool) -> Report {
    let rates = tuning().rates;
    let (_, current) = evaluate(observations, &rates, MULTI_WORD);
    let (_, lowest) = evaluate(observations, &rates, MultiWord::Lowest);
    let (_, average) = evaluate(observations, &rates, MultiWord::Average);
    Report {
        current,
        lowest: lowest.log_loss,
        average: average.log_loss,
        best: with_search.then(|| search(observations)),
    }
}

pub fn format_report(report: &Report, observations: &[Observation]) -> String {
    let mut out = String::new();
    let rates = tuning().rates;
    let _ = writeln!(out, "answers replayed: {}", report.current.answers);
    let _ = writeln!(
        out,
        "log loss: {:.4}  (always guessing the log's own rate: {:.4})",
        report.current.log_loss,
        baseline(observations)
    );
    let memories: Vec<f64> = observations
        .iter()
        .flat_map(|o| o.words.iter().map(|w| w.memory))
        .collect();
    if !memories.is_empty() {
        let _ = writeln!(
            out,
            "mean memory at answer time: {:.3} · answered right: {:.1}%",
            memories.iter().sum::<f64>() / memories.len() as f64,
            100.0 * observations.iter().map(|o| o.outcome).sum::<f64>()
                / observations.len().max(1) as f64
        );
    }
    let _ = writeln!(
        out,
        "rates: word {} · shared {} · challenge {} · several words: {:?}",
        rates.word, rates.shared, rates.challenge, MULTI_WORD
    );
    let _ = writeln!(
        out,
        "several words — lowest skill: {:.4} · average skill: {:.4}",
        report.lowest, report.average
    );
    let _ = writeln!(out);
    let _ = writeln!(out, "predicted     answers  mean predicted  actually right");
    for band in &report.current.bands {
        let _ = writeln!(
            out,
            "{:>3.0}–{:<3.0}%  {:>9}  {:>13.1}%  {:>13.1}%",
            band.from * 100.0,
            band.to * 100.0,
            band.answers,
            band.predicted * 100.0,
            band.actual * 100.0
        );
    }
    if let Some(best) = &report.best {
        let _ = writeln!(out);
        let _ = writeln!(
            out,
            "best of the grid: word {} · shared {} · challenge {} · {:?} → {:.4}",
            best.rates.word, best.rates.shared, best.rates.challenge, best.multi, best.log_loss
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::replay::{input_from_events, observations, parse_export};
    use crate::sim::{simulate, SimOptions};
    use sapling_domain::events::PROFILE_ID;

    fn fixture() -> Vec<Observation> {
        let sim = simulate(SimOptions::default());
        let events = parse_export(&sim.export_json()).unwrap();
        observations(&input_from_events(&events, PROFILE_ID))
    }

    /// The fixture log is the simulated learner: learning from it has to beat
    /// guessing its average, and the bands have to mean what they say.
    #[test]
    fn the_model_beats_the_baseline_and_its_bands_are_honest() {
        let seen = fixture();
        let report = calibrate(&seen, false);
        assert!(report.current.answers > 1000, "{}", report.current.answers);
        assert!(
            report.current.log_loss < baseline(&seen) - 0.01,
            "{} vs {}",
            report.current.log_loss,
            baseline(&seen)
        );
        for band in &report.current.bands {
            if band.answers >= 150 {
                assert!(
                    (band.predicted - band.actual).abs() < 0.12,
                    "{:.2}: predicted {:.3}, actual {:.3}",
                    band.from,
                    band.predicted,
                    band.actual
                );
            }
        }
        let text = format_report(&report, &seen);
        assert!(text.contains("log loss") && text.contains("lowest skill"));
    }

    /// §12.1: the combination that scored better on the fixture log is the
    /// default, and the current rates are the grid's best within a hair.
    #[test]
    fn the_defaults_are_what_the_fixture_log_chose() {
        let seen = fixture();
        let report = calibrate(&seen, true);
        let expected = if report.lowest <= report.average {
            MultiWord::Lowest
        } else {
            MultiWord::Average
        };
        assert_eq!(MULTI_WORD, expected);
        let best = report.best.unwrap();
        assert!(
            report.current.log_loss - best.log_loss < 0.005,
            "current {:.4}, best {:.4} at {:?}",
            report.current.log_loss,
            best.log_loss,
            best
        );
    }
}
