//! The policy that goes with `model_v2.rs`, a research prototype wired into
//! nothing but the closed-loop simulation (`sim::closed_loop`).
//!
//! **Fit is a ranking, not a filter.** A row is available when it is playable,
//! of an active kind, not spent, not shown this stream, and rested or its word
//! due — the first model's predicate without `fits`. Among the head word's
//! available rows and help levels, a pick takes one posterior draw — the
//! shared numbers jointly, a row's correction on its own, the word's skill
//! left as its distribution given that draw — and takes the one whose
//! *sampled* remembered chance is closest to the aim. Draws are half as wide
//! as the posterior by default ([`Steering`]): full-width Thompson sampling
//! explored too much in the simulation. With ordered parts a draw may not make
//! a harder help level of a row look easier than an easier one.
//!
//! **Refill keeps stock**: each of the next few words keeps [`STOCK`] available
//! rows, spread across kinds, and gets one more (up to [`MOST`]) while even its
//! best row's mean chance sits outside a band ([`Steering::band`]). The kind
//! and length to write are chosen by the same sampled rule.

use std::collections::{HashMap, HashSet};

use crate::fits::{help_levels, written_levels, Serving};
use crate::help::HelpLevel;
use crate::kinds::{active_kinds, kind_of, ChallengeKind, Want, WantItem, WireType};
use crate::model::{length_of, target, Evidence, Observation};
use crate::model_v2::{Draw, ModelV2, Parts};
use crate::pool::{is_playable, is_rested, is_spent, known_ids, PoolRow};
use crate::rng::Rng;
use crate::text::js_trim;
use crate::word::{by_id, ById, Word};

/// Available rows each upcoming word keeps.
pub const STOCK: usize = 2;
/// The most a word is written up to while its best row is out of the band.
pub const MOST: usize = 4;
/// The default [`Steering::band`].
pub const BAND: [f64; 2] = [0.5, 0.98];

/// How a pick explores and when a refill writes more.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Steering {
    /// Whether the word's skill is drawn too. Off, it enters as its
    /// distribution given the shared draw: every row of the word teaches its
    /// skill alike, so exploring it buys nothing and only adds noise.
    pub skill: bool,
    /// Draws are this many standard deviations wide: 1 is Thompson sampling.
    pub scale: f64,
    /// The width shrinks as `1/√(1 + answers/decay)`; infinite keeps it.
    pub decay: f64,
    /// Remembered chances a word's best row may sit at before a write is asked.
    pub band: [f64; 2],
}

impl Steering {
    /// The prototype's first round: plain Thompson sampling.
    pub const FIRST: Steering = Steering {
        skill: false,
        scale: 1.0,
        decay: f64::INFINITY,
        band: BAND,
    };

    fn width(&self, model: &ModelV2) -> f64 {
        self.scale / (1.0 + model.answers() as f64 / self.decay).sqrt()
    }

    fn draw<'a>(&self, model: &'a ModelV2, now: f64, rng: &'a mut Rng) -> Draw<'a> {
        Draw::new(model, now, self.width(model), self.skill, rng)
    }
}

impl Default for Steering {
    fn default() -> Self {
        Steering {
            scale: 0.5,
            ..Steering::FIRST
        }
    }
}

fn urgency(words: &[Word], now: f64) -> Vec<&Word> {
    let mut sorted: Vec<&Word> = words.iter().filter(|w| w.is_writable()).collect();
    sorted.sort_by(|a, b| {
        a.due_at(now)
            .total_cmp(&b.due_at(now))
            .then_with(|| a.id.cmp(&b.id))
    });
    sorted
}

/// A row at a help level as the model reads it.
pub fn observation(
    challenge_id: &str,
    kind: WireType,
    help: HelpLevel,
    length: f64,
    item_ids: &[String],
    words: &ById,
    now: f64,
) -> Option<Observation> {
    let mut evidence = Vec::with_capacity(item_ids.len());
    for id in item_ids {
        evidence.push(Evidence {
            item_id: id.clone(),
            memory: words.get(id.as_str())?.memory(),
        });
    }
    Some(Observation {
        at: now,
        challenge_id: challenge_id.to_owned(),
        kind,
        help,
        length,
        words: evidence,
        outcome: 0.0,
    })
}

struct Candidate {
    at: usize,
    help: HelpLevel,
    rested: bool,
    seen: Observation,
}

struct Index<'a> {
    pool: &'a [Option<PoolRow>],
    about: HashMap<&'a str, Vec<usize>>,
    known: HashSet<&'a str>,
    served: HashSet<&'a str>,
    words: ById<'a>,
    serving: &'a Serving,
    now: f64,
}

impl<'a> Index<'a> {
    fn new(ask: &Ask<'a>) -> Self {
        let Ask {
            pool,
            words,
            served,
            serving,
            now,
            ..
        } = *ask;
        let mut about: HashMap<&str, Vec<usize>> = HashMap::new();
        for (at, row) in pool.iter().enumerate() {
            for item in row.iter().flat_map(|r| r.challenge.item_ids()) {
                about.entry(item.as_str()).or_default().push(at);
            }
        }
        Index {
            pool,
            about,
            known: known_ids(words),
            served: served.iter().map(String::as_str).collect(),
            words: by_id(words),
            serving,
            now,
        }
    }

    /// Every available row of `word` at every help level it can be shown at.
    fn options(&self, word: &Word) -> Vec<Candidate> {
        let due = word.is_due(self.now);
        let mut out = Vec::new();
        for &at in self.about.get(word.id.as_str()).into_iter().flatten() {
            let Some(row) = self.pool[at].as_ref() else {
                continue;
            };
            let Some(kind) = kind_of(&row.challenge).filter(|k| k.is_active()) else {
                continue;
            };
            let rested = is_rested(row, self.now);
            let ok = is_playable(row, &self.known)
                && !is_spent(row)
                && !self.served.contains(row.challenge.id())
                && (due || rested);
            if !ok {
                continue;
            }
            let length = length_of(&row.challenge);
            for help in help_levels(&row.challenge, self.serving) {
                let Some(seen) = observation(
                    row.challenge.id(),
                    kind,
                    help,
                    length,
                    row.challenge.item_ids(),
                    &self.words,
                    self.now,
                ) else {
                    break;
                };
                out.push(Candidate {
                    at,
                    help,
                    rested,
                    seen,
                });
            }
        }
        out
    }
}

/// What a pick or a refill is asked against.
#[derive(Clone, Copy)]
pub struct Ask<'a> {
    pub pool: &'a [Option<PoolRow>],
    pub words: &'a [Word],
    pub now: f64,
    /// The rows this stream has shown.
    pub served: &'a [String],
    /// The words a local kind may be written for.
    pub cued: &'a [String],
    pub serving: &'a Serving,
}

/// What a pick serves: a row, its help level, and whether the head was passed.
#[derive(Debug, Clone, PartialEq)]
pub struct Pick {
    pub word: String,
    pub at: usize,
    pub help: HelpLevel,
    /// The sampled remembered chance the pick was made at.
    pub sampled: f64,
    pub passed: bool,
}

/// The head word's pick, or — when it has nothing — the first word further
/// down the list with something.
pub fn pick(ask: &Ask, model: &ModelV2, steering: Steering, rng: &mut Rng) -> Option<Pick> {
    let cx = Index::new(ask);
    let (now, aim) = (ask.now, target(ask.serving.aim));
    for (i, word) in urgency(ask.words, now).into_iter().enumerate() {
        let options = cx.options(word);
        if options.is_empty() {
            continue;
        }
        let mut draws = steering.draw(model, now, rng);
        let ordered = model.config.parts == Parts::Ordered;
        let mut best: Option<(bool, f64, &Candidate, f64)> = None;
        // A row's levels come easiest first; ordered, a draw may not make a
        // harder one look easier.
        let mut ceiling = (usize::MAX, 1.0f64);
        for option in &options {
            let mut sampled = draws.chance(&option.seen);
            if ordered {
                if ceiling.0 != option.at {
                    ceiling = (option.at, 1.0);
                }
                sampled = sampled.min(ceiling.1);
                ceiling.1 = sampled;
            }
            let key = (!option.rested, (sampled - aim).abs());
            if best.is_none_or(|(r, d, _, _)| key.0.cmp(&r).then(key.1.total_cmp(&d)).is_lt()) {
                best = Some((key.0, key.1, option, sampled));
            }
        }
        let (_, _, option, sampled) = best.expect("not empty");
        return Some(Pick {
            word: word.id.clone(),
            at: option.at,
            help: option.help,
            sampled,
            passed: i > 0,
        });
    }
    None
}

/// The kind and length a sampled draw puts nearest the aim at the kind's
/// middle help level, and how near.
fn best_length(
    word: &Word,
    kind: WireType,
    serving: &Serving,
    draws: &mut Draw,
    index: &ById,
    now: f64,
    aim: f64,
) -> Option<(u8, f64)> {
    let [shortest, longest] = kind.lengths()?;
    let levels = written_levels(kind, serving);
    let (first, last) = (*levels.first()?, *levels.last()?);
    let ids = [word.id.clone()];
    let mut best: Option<(u8, f64)> = None;
    for length in shortest..=longest {
        let chance = |help, draws: &mut Draw| {
            observation("", kind, help, f64::from(length), &ids, index, now)
                .map(|o| draws.chance(&o))
        };
        let middle = (chance(first, draws)? + chance(last, draws)?) / 2.0;
        let distance = (middle - aim).abs();
        if best.is_none_or(|(_, d)| distance < d) {
            best = Some((length, distance));
        }
    }
    best
}

/// The rows to write for the first `limit` words of the list.
pub fn refill(
    ask: &Ask,
    limit: usize,
    model: &ModelV2,
    steering: Steering,
    rng: &mut Rng,
) -> Vec<Want> {
    let cx = Index::new(ask);
    let Ask {
        pool, now, serving, ..
    } = *ask;
    let aim = target(serving.aim);
    let mut wants = Vec::new();
    for word in urgency(ask.words, now).into_iter().take(limit) {
        let options = cx.options(word);
        let rows: HashSet<usize> = options.iter().map(|o| o.at).collect();
        let best = options
            .iter()
            .map(|o| model.remembered(&o.seen))
            .min_by(|a, b| (a - aim).abs().total_cmp(&(b - aim).abs()));
        let [low, high] = steering.band;
        let outside = best.is_none_or(|c| c < low || c > high);
        let count = if rows.len() < STOCK {
            STOCK - rows.len()
        } else if rows.len() < MOST && outside {
            1
        } else {
            0
        };
        if count == 0 {
            continue;
        }
        let stocked: HashSet<WireType> = rows
            .iter()
            .filter_map(|&at| kind_of(&pool[at].as_ref()?.challenge))
            .collect();
        let cued = ask.cued.contains(&word.id);
        let kinds: Vec<WireType> = active_kinds().filter(|k| cued || !k.is_local()).collect();
        let mut draws = steering.draw(model, now, rng);
        let mut chosen: Vec<WireType> = Vec::new();
        for _ in 0..count {
            let fresh: Vec<WireType> = kinds
                .iter()
                .copied()
                .filter(|k| !chosen.contains(k) && !stocked.contains(k))
                .collect();
            let from = if fresh.is_empty() {
                kinds
                    .iter()
                    .copied()
                    .filter(|k| !chosen.contains(k))
                    .collect()
            } else {
                fresh
            };
            let mut best: Option<(WireType, u8, f64)> = None;
            for kind in from {
                let Some((length, distance)) =
                    best_length(word, kind, serving, &mut draws, &cx.words, now, aim)
                else {
                    continue;
                };
                if best.is_none_or(|(_, _, d)| distance < d) {
                    best = Some((kind, length, distance));
                }
            }
            let Some((kind, length, _)) = best else {
                break;
            };
            chosen.push(kind);
            wants.push(Want {
                item: WantItem {
                    id: word.id.clone(),
                    term: js_trim(&word.term).to_owned(),
                    meaning: js_trim(&word.meaning).to_owned(),
                },
                kind: ChallengeKind { kind },
                length,
            });
        }
    }
    wants
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::help::Step;
    use crate::model_v2::Config;
    use crate::stream::tests::rows;
    use crate::topup::tests::{pooled, word, DAY, NOW};

    fn ask<'a>(pool: &'a [Option<PoolRow>], words: &'a [Word], serving: &'a Serving) -> Ask<'a> {
        Ask {
            pool,
            words,
            now: NOW,
            served: &[],
            cued: &[],
            serving,
        }
    }

    fn skilled(id: &str) -> Word {
        let mut w = word(id, -DAY, 0.5);
        w.skill = None;
        w
    }

    /// Two single-level rows about one word: how often each is picked.
    fn shares(model: &ModelV2, steering: Steering, seeds: u64) -> (usize, usize) {
        let words = [skilled("w")];
        let pool = rows(&[
            pooled("easy", WireType::RecognizeMc, &["w"], None),
            pooled("other", WireType::TranslateToNative, &["w"], None),
        ]);
        let serving = Serving::default();
        let mut counts = (0, 0);
        for seed in 0..seeds {
            let mut rng = Rng::seeded(seed);
            let p = pick(&ask(&pool, &words, &serving), model, steering, &mut rng).unwrap();
            if p.at == 0 {
                counts.0 += 1;
            } else {
                counts.1 += 1;
            }
        }
        counts
    }

    /// `answers` answers about other words, `right` in every ten correct.
    fn settle(model: &mut ModelV2, kind: WireType, right: usize, answers: usize, at: f64) {
        for i in 0..answers {
            let o = Observation {
                at,
                challenge_id: format!("{}-{i}", kind.as_str()),
                kind,
                help: HelpLevel::step(Step::Plain),
                length: 1.0,
                words: vec![Evidence {
                    item_id: format!("other-{i}"),
                    memory: 1.0,
                }],
                outcome: f64::from(u8::from(i % 10 < right)),
            };
            model.learn(&o);
        }
    }

    #[test]
    fn a_confidently_bad_row_is_rarely_picked_an_uncertain_one_sometimes() {
        let config = Config {
            part_forget: 30.0,
            ..Config::default()
        };
        let at = |when: f64| {
            let mut model = ModelV2::new(config);
            // Recognition settled near the aim, translation far too hard.
            settle(&mut model, WireType::RecognizeMc, 9, 100, when);
            settle(&mut model, WireType::TranslateToNative, 2, 100, when);
            model
        };
        let (_, bad) = shares(&at(NOW), Steering::FIRST, 400);
        assert!(bad < 4, "{bad}");
        // The same verdict on two answers is thin: it gets retested.
        let mut thin = ModelV2::new(config);
        settle(&mut thin, WireType::RecognizeMc, 9, 100, NOW);
        settle(&mut thin, WireType::TranslateToNative, 0, 2, NOW);
        let (_, uncertain) = shares(&thin, Steering::FIRST, 400);
        assert!(uncertain > 10, "{uncertain}");
        // Narrower draws explore it less.
        let (_, narrow) = shares(&thin, Steering::default(), 400);
        assert!(narrow < uncertain, "{narrow} vs {uncertain}");
        // And so is the confident verdict once it has gone untested for months.
        let (_, retested) = shares(&at(NOW - 120.0 * DAY), Steering::FIRST, 400);
        assert!(retested > 15, "{retested}");
    }

    #[test]
    fn a_pick_and_a_refill_replay_under_a_seed() {
        let words = [skilled("a"), skilled("b")];
        let pool = rows(&[
            pooled("c1", WireType::Cloze, &["a"], None),
            pooled("c2", WireType::RecognizeMc, &["a"], None),
        ]);
        let model = ModelV2::new(Config::default());
        let serving = Serving::default();
        let run = |seed| {
            let mut rng = Rng::seeded(seed);
            let asked = ask(&pool, &words, &serving);
            let p = pick(&asked, &model, Steering::default(), &mut rng);
            let w = refill(&asked, 5, &model, Steering::default(), &mut rng);
            (p, w)
        };
        assert_eq!(run(3), run(3));
        let (_, wants) = run(3);
        // "b" has nothing: two rows of two different kinds.
        let b: Vec<&Want> = wants.iter().filter(|w| w.item.id == "b").collect();
        assert_eq!(b.len(), STOCK);
        assert_ne!(b[0].kind, b[1].kind);
        // "a" has two rows; its best is inside the band, so nothing more.
        assert!(wants.iter().all(|w| w.item.id != "a"));
    }

    #[test]
    fn a_word_whose_best_row_is_far_off_gets_one_more() {
        let words = [skilled("a")];
        let pool = rows(&[
            pooled("c1", WireType::Cloze, &["a"], None),
            pooled("c2", WireType::Cloze, &["a"], None),
        ]);
        let mut model = ModelV2::new(Config::default());
        model.mislead(WireType::Cloze, 6.0, NOW);
        let serving = Serving::default();
        let wants = refill(
            &ask(&pool, &words, &serving),
            5,
            &model,
            Steering::default(),
            &mut Rng::seeded(1),
        );
        assert_eq!(wants.len(), 1);
        assert_ne!(wants[0].kind.kind, WireType::Cloze);
    }
}
