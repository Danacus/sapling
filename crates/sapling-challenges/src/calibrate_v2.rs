//! The calibration command's report for `model_v2.rs`: the same prequential
//! replay as `calibrate.rs` (predict each answer, then learn from it), Brier
//! beside log loss, the bands, and every shared belief at the end of the log —
//! its mean, its spread, how many answers moved it and how long ago the last
//! did, which is what shows a number frozen by what serving let through.
//! `ablations` scores each design choice against the first model's.

use std::collections::BTreeMap;
use std::fmt::Write;

use crate::help::HelpLevel;
use crate::kinds::WireType;
use crate::model::{part_key, tuning, Learner, Observation, MULTI_WORD};
use crate::model_v2::{
    evaluate, score, Config, Key, Length, Memory, ModelV2, Parts, Prior, ScoreV2,
};

const DAY: f64 = 86_400_000.0;

/// The first model at its tuned rates, scored the same way.
pub fn current(observations: &[Observation]) -> ScoreV2 {
    let mut learner = Learner::default();
    let rates = tuning().rates;
    let pairs: Vec<(f64, f64)> = observations
        .iter()
        .map(|o| (learner.learn(o, &rates, MULTI_WORD), o.outcome))
        .collect();
    score(&pairs)
}

/// The round-two steps, each on top of the one before, then single changes
/// against the last.
pub fn variants() -> Vec<(&'static str, Config)> {
    let first = Config::FIRST;
    let feature = Config {
        memory: Memory::Feature,
        ..first
    };
    let joint = Config {
        joint: true,
        part_forget: 180.0,
        ..feature
    };
    let last = Config::default();
    let with = |name, config| (name, config);
    vec![
        with("r1", first),
        with("+memory", feature),
        with("+joint", joint),
        with("+ordered", last),
        with(
            "memory=product",
            Config {
                memory: Memory::Product,
                ..last
            },
        ),
        with(
            "memory=off",
            Config {
                memory: Memory::Off,
                ..last
            },
        ),
        with(
            "joint=off",
            Config {
                joint: false,
                ..last
            },
        ),
        with(
            "parts=flat",
            Config {
                parts: Parts::Flat,
                ..last
            },
        ),
        with(
            "parts=factored",
            Config {
                parts: Parts::Factored,
                ..last
            },
        ),
        with(
            "prior=empirical",
            Config {
                prior: Prior::Empirical,
                ..last
            },
        ),
        with(
            "prior=starting",
            Config {
                prior: Prior::Starting,
                ..last
            },
        ),
        with(
            "length=fixed",
            Config {
                length: Length::Fixed,
                ..last
            },
        ),
        with(
            "length=off",
            Config {
                length: Length::Off,
                ..last
            },
        ),
        with(
            "forget=60",
            Config {
                part_forget: 60.0,
                ..last
            },
        ),
        with(
            "noise=off",
            Config {
                skill_forget: f64::INFINITY,
                part_forget: f64::INFINITY,
                ..last
            },
        ),
    ]
}

/// How far the bands sit from the diagonal, weighted by their answers, and
/// which way: above zero is overconfident.
pub fn calibration(s: &ScoreV2) -> (f64, f64) {
    let n = s.answers.max(1) as f64;
    let ece = s
        .bands
        .iter()
        .map(|b| b.answers as f64 * (b.predicted - b.actual).abs())
        .sum::<f64>()
        / n;
    let bias = s
        .bands
        .iter()
        .map(|b| b.answers as f64 * (b.predicted - b.actual))
        .sum::<f64>()
        / n;
    (ece, bias)
}

fn last_third(pairs: &[(f64, f64)]) -> f64 {
    score(&pairs[pairs.len() * 2 / 3..]).log_loss
}

/// A replay's `(predicted, outcome)` pairs.
pub type Predict<'a> = &'a dyn Fn(&[Observation]) -> Vec<(f64, f64)>;

/// One line per model; over several logs, each number is the mean of the logs'.
pub fn table(logs: &[Vec<Observation>], rows: &[(&str, Predict)]) -> String {
    let mut out = String::new();
    let _ = writeln!(
        out,
        "{:<18} {:>8} {:>8} {:>8} {:>8} {:>10}",
        "model", "logloss", "brier", "ECE", "bias", "LL last⅓"
    );
    for (name, predict) in rows {
        let mut sums = [0.0; 5];
        for log in logs {
            let pairs = predict(log);
            let s = score(&pairs);
            let (ece, bias) = calibration(&s);
            for (sum, value) in
                sums.iter_mut()
                    .zip([s.log_loss, s.brier, ece, bias, last_third(&pairs)])
            {
                *sum += value / logs.len().max(1) as f64;
            }
        }
        let [loss, brier, ece, bias, last] = sums;
        let _ = writeln!(
            out,
            "{name:<18} {loss:>8.4} {brier:>8.4} {ece:>8.4} {bias:>+8.4} {last:>10.4}"
        );
    }
    out
}

/// The first model's pairs at its tuned rates.
pub fn first_model(log: &[Observation]) -> Vec<(f64, f64)> {
    let mut learner = Learner::default();
    let rates = tuning().rates;
    log.iter()
        .map(|o| (learner.learn(o, &rates, MULTI_WORD), o.outcome))
        .collect()
}

/// A model, replayed over a log.
pub type Model = Box<dyn Fn(&[Observation]) -> Vec<(f64, f64)>>;

/// Every variant's scores, one line each, the first model first.
pub fn ablations(logs: &[Vec<Observation>]) -> String {
    let mut models: Vec<(&str, Model)> = vec![("current", Box::new(first_model))];
    for (name, config) in variants() {
        models.push((
            name,
            Box::new(move |log| {
                let mut model = ModelV2::new(config);
                log.iter().map(|o| (model.learn(o), o.outcome)).collect()
            }),
        ));
    }
    let rows: Vec<(&str, Predict)> = models.iter().map(|(n, f)| (*n, f.as_ref())).collect();
    table(logs, &rows)
}

/// The grid `--search` tries for the prior spreads and the drift.
pub const SKILL_SDS: [f64; 3] = [1.0, 1.5, 2.0];
pub const PART_SDS: [f64; 3] = [1.0, 1.5, 2.0];
pub const ROW_SDS: [f64; 3] = [0.25, 0.5, 0.8];
pub const FORGETS: [f64; 4] = [30.0, 90.0, 365.0, f64::INFINITY];

/// The grid point with the lowest mean log loss over several logs.
pub fn search(logs: &[Vec<Observation>], base: Config) -> (Config, f64) {
    let mut best: Option<(Config, f64)> = None;
    for skill_sd in SKILL_SDS {
        for part_sd in PART_SDS {
            for row_sd in ROW_SDS {
                for skill_forget in FORGETS {
                    for part_forget in FORGETS {
                        let config = Config {
                            skill_sd,
                            part_sd,
                            row_sd,
                            skill_forget,
                            part_forget,
                            ..base
                        };
                        let loss = logs
                            .iter()
                            .map(|log| evaluate(log, config).1.log_loss)
                            .sum::<f64>()
                            / logs.len().max(1) as f64;
                        if best.is_none_or(|(_, l)| loss < l) {
                            best = Some((config, loss));
                        }
                    }
                }
            }
        }
    }
    best.expect("a non-empty grid")
}

fn describe(key: &Key) -> Option<String> {
    Some(match key {
        Key::Part(k) => k.clone(),
        Key::Kind(k) => format!("kind {k}"),
        Key::Step(s) => format!("step {s}"),
        Key::Slope(k) => format!("slope {k}"),
        Key::Memory => "memory weight".to_owned(),
        Key::Skill(_) | Key::Row(_) => return None,
    })
}

/// The v2 report: scores, bands, and every shared belief at the log's end.
pub fn format_v2(observations: &[Observation], config: Config) -> String {
    let (model, s) = evaluate(observations, config);
    let first = current(observations);
    let mut out = String::new();
    let _ = writeln!(out, "model v2: {config:?}");
    let _ = writeln!(
        out,
        "answers replayed: {} · log loss {:.4} (first model {:.4}) · Brier {:.4} (first model {:.4})",
        s.answers, s.log_loss, first.log_loss, s.brier, first.brier
    );
    let _ = writeln!(out);
    let _ = writeln!(out, "predicted     answers  mean predicted  actually right");
    for band in &s.bands {
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
    let end = observations.iter().map(|o| o.at).fold(f64::MIN, f64::max);
    let mut first_model = Learner::default();
    for o in observations {
        first_model.learn(o, &tuning().rates, MULTI_WORD);
    }
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "{:<32} {:>8} {:>7} {:>8} {:>9} {:>11}",
        "belief", "mean", "sd now", "answers", "last (d)", "first model"
    );
    for (key, b) in &model.beliefs(end) {
        let Some(name) = describe(key) else {
            continue;
        };
        let first = match key {
            Key::Part(k) => first_model.shared.bases.get(k).map(|v| format!("{v:.2}")),
            Key::Slope(k) => first_model.shared.slopes.get(*k).map(|v| format!("{v:.3}")),
            _ => None,
        };
        let _ = writeln!(
            out,
            "{name:<32} {:>8.3} {:>7.3} {:>8} {:>9.1} {:>11}",
            b.mean,
            b.var.sqrt(),
            b.answers,
            (end - b.at) / DAY,
            first.unwrap_or_else(|| "—".to_owned())
        );
    }
    let _ = writeln!(out);
    let _ = writeln!(
        out,
        "{:<32} {:>8} {:>7} {:>9}   (at the middle length; sd: the difficulty alone, jointly; pick sd: skill − difficulty for a word with 5+ answers)",
        "kind and help level", "mean", "sd", "pick sd"
    );
    let mut parts: BTreeMap<String, (WireType, HelpLevel)> = BTreeMap::new();
    for o in observations {
        parts.insert(part_key(o.kind, o.help), (o.kind, o.help));
    }
    for (key, (kind, help)) in parts {
        let (mean, sd) = model.difficulty(kind, help, end);
        let pick = model.decision_sd(kind, help, 5, end);
        let _ = writeln!(out, "{key:<32} {mean:>8.3} {sd:>7.3} {pick:>9.3}");
    }
    let skills: Vec<f64> = model
        .beliefs(end)
        .iter()
        .filter(|(k, _)| matches!(k, Key::Skill(_)))
        .map(|(_, b)| b.mean)
        .collect();
    if !skills.is_empty() {
        let mean = skills.iter().sum::<f64>() / skills.len() as f64;
        let sd =
            (skills.iter().map(|s| (s - mean).powi(2)).sum::<f64>() / skills.len() as f64).sqrt();
        let _ = writeln!(
            out,
            "word skills: {} words, mean {mean:.2}, spread {sd:.2}",
            skills.len()
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::evaluate as evaluate_v1;
    use crate::replay::{input_from_events, observations, parse_export};
    use crate::sim::{simulate, SimOptions};
    use sapling_domain::events::PROFILE_ID;

    #[test]
    fn the_v2_report_scores_every_variant_and_lists_its_beliefs() {
        let sim = simulate(SimOptions {
            days: 20,
            ..SimOptions::default()
        });
        let seen = observations(&input_from_events(
            &parse_export(&sim.export_json()).unwrap(),
            PROFILE_ID,
        ));
        let table = ablations(std::slice::from_ref(&seen));
        assert_eq!(table.lines().count(), 2 + variants().len());
        let report = format_v2(&seen, Config::default());
        assert!(report.contains("cloze/pick-4") && report.contains("slope cloze"));
        let (v2, _) = evaluate(&seen, Config::default());
        assert!(v2.beliefs(0.0).len() > seen.len() / 10);
        // The first model is scored exactly as `calibrate.rs` scores it.
        let first = current(&seen);
        let (_, v1) = evaluate_v1(&seen, &tuning().rates, MULTI_WORD);
        assert!((first.log_loss - v1.log_loss).abs() < 1e-12);
    }
}
