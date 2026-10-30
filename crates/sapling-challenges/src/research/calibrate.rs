//! Scoring the difficulty model on a log: every answer predicted by the app's
//! `Ratings` before it learns from it — the very fold `sapling-db`'s
//! `learned.rs` keeps — scored by log loss, Brier and calibration bands, with
//! the ratings as they stand at the end. `search` tries a small grid of the
//! free numbers in `data/model.json` on the same log.

use std::fmt::Write;

use crate::model::Observation;
use crate::ratings::{Key, Ratings, Starts};

const DAY: f64 = 86_400_000.0;

/// Folds the answers in order; each pair is the chance given before learning
/// from it, and the outcome.
pub fn replay(log: &[Observation], starts: Starts) -> (Ratings, Vec<(f64, f64)>) {
    let mut ratings = Ratings::with_starts(starts);
    let pairs = log.iter().map(|o| (ratings.learn(o), o.outcome)).collect();
    (ratings, pairs)
}

#[derive(Debug, Clone, PartialEq)]
pub struct Band {
    pub from: f64,
    pub to: f64,
    pub answers: usize,
    pub predicted: f64,
    pub actual: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Score {
    pub answers: usize,
    pub log_loss: f64,
    pub brier: f64,
    pub bands: Vec<Band>,
}

/// Each prediction clamped to 1–99%.
pub fn score(pairs: &[(f64, f64)]) -> Score {
    let mut loss = 0.0;
    let mut brier = 0.0;
    let mut sums = [(0usize, 0.0f64, 0.0f64); 10];
    for &(p, y) in pairs {
        let p = p.clamp(0.01, 0.99);
        loss -= y * p.ln() + (1.0 - y) * (1.0 - p).ln();
        brier += (p - y).powi(2);
        let band = ((p * 10.0) as usize).min(9);
        sums[band].0 += 1;
        sums[band].1 += p;
        sums[band].2 += y;
    }
    let n = pairs.len().max(1) as f64;
    Score {
        answers: pairs.len(),
        log_loss: loss / n,
        brier: brier / n,
        bands: sums
            .iter()
            .enumerate()
            .filter(|(_, (n, _, _))| *n > 0)
            .map(|(i, (n, p, y))| Band {
                from: i as f64 / 10.0,
                to: (i + 1) as f64 / 10.0,
                answers: *n,
                predicted: p / *n as f64,
                actual: y / *n as f64,
            })
            .collect(),
    }
}

/// Always guessing the log's own success rate: the score to beat.
pub fn baseline(log: &[Observation]) -> f64 {
    let rate = log.iter().map(|o| o.outcome).sum::<f64>() / log.len().max(1) as f64;
    let pairs: Vec<(f64, f64)> = log.iter().map(|o| (rate, o.outcome)).collect();
    score(&pairs).log_loss
}

pub const WORD_STARTS: [f64; 6] = [-0.5, 0.0, 0.5, 1.0, 1.5, 2.0];
pub const WORD_MARGINS: [f64; 4] = [0.25, 0.5, 1.0, 1.5];
pub const CHALLENGE_MARGINS: [f64; 4] = [0.5, 1.0, 1.5, 2.0];
pub const WIDENS: [f64; 4] = [0.0, 0.005, 0.02, 0.05];

/// The grid point with the lowest log loss on `log`.
pub fn search(log: &[Observation]) -> (Starts, f64) {
    let mut best: Option<(Starts, f64)> = None;
    for word_start in WORD_STARTS {
        for word_margin in WORD_MARGINS {
            for challenge_margin in CHALLENGE_MARGINS {
                for widen in WIDENS {
                    let starts = Starts {
                        word_start,
                        word_margin,
                        challenge_margin,
                        widen,
                    };
                    let loss = score(&replay(log, starts).1).log_loss;
                    if best.is_none_or(|(_, l)| loss < l) {
                        best = Some((starts, loss));
                    }
                }
            }
        }
    }
    best.expect("a non-empty grid")
}

fn describe(s: Starts) -> String {
    format!(
        "word start {} · word margin {} · challenge margin {} · widen {}",
        s.word_start, s.word_margin, s.challenge_margin, s.widen
    )
}

/// The scores, the bands and every rating at the end of the log.
pub fn report(log: &[Observation], with_search: bool) -> String {
    let current = Starts::default();
    let (ratings, pairs) = replay(log, current);
    let s = score(&pairs);
    let mut out = String::new();
    let _ = writeln!(
        out,
        "answers {} · log loss {:.4} · Brier {:.4}  (always guessing the log's own rate: {:.4})",
        s.answers,
        s.log_loss,
        s.brier,
        baseline(log)
    );
    if with_search {
        let (best, loss) = search(log);
        let _ = writeln!(out, "current: {} → {:.4}", describe(current), s.log_loss);
        let _ = writeln!(out, "best:    {} → {loss:.4}", describe(best));
    }
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
    for (key, r) in ratings.all() {
        let name = match key {
            Key::Challenge(k) => k.clone(),
            Key::Scale => "stability scale".to_owned(),
            Key::Base => "stability base".to_owned(),
            Key::Slope(k) => format!("slope/{k}"),
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
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help::{HelpLevel, Step};
    use crate::kinds::WireType;
    use crate::ratings::tests::answer;

    fn log() -> Vec<Observation> {
        (0..200)
            .map(|i| {
                let typed = i % 2 == 0;
                let help = HelpLevel::step(if typed { Step::Typed } else { Step::Pick4 });
                let right = if typed { i % 3 == 0 } else { i % 10 != 0 };
                answer(WireType::Cloze, help, f64::from(right), f64::from(i) * DAY)
            })
            .collect()
    }

    #[test]
    fn each_answer_is_predicted_before_it_is_learned_by_the_apps_fold() {
        let log = log();
        let (ratings, pairs) = replay(&log, Starts::default());
        let mut app = Ratings::default();
        for (o, (p, y)) in log.iter().zip(&pairs) {
            assert_eq!(app.chance(o), *p);
            assert_eq!(o.outcome, *y);
            app.learn(o);
        }
        assert_eq!(app, ratings);
        assert!(score(&pairs).log_loss < baseline(&log));
    }

    #[test]
    fn the_score_bands_and_the_report_say_what_they_measured() {
        let s = score(&[(0.95, 1.0), (0.95, 0.0), (0.15, 0.0)]);
        assert_eq!(s.answers, 3);
        assert_eq!(s.bands.len(), 2);
        assert_eq!(s.bands[1].actual, 0.5);
        assert!(
            (s.brier - (0.05f64.powi(2) + 0.95f64.powi(2) + 0.15f64.powi(2)) / 3.0).abs() < 1e-12
        );
        let text = report(&log(), true);
        for needle in [
            "log loss",
            "cloze/typed",
            "cloze/pick-4",
            "stability scale",
            "slope/cloze",
            "best:",
        ] {
            assert!(text.contains(needle), "{needle}");
        }
    }
}
