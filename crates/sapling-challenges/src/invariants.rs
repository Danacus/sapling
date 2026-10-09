//! The invariants that make the stream unable to strand a word: serving and
//! refill read one list through one predicate, and the writer solves the very
//! check serving applies, so a refill always unblocks the head.
//!
//! They hold under every readings setting a learner can pick, for a language
//! written with readings and one without, and for rows about several words —
//! a multi-cloze names a second word beside the one it was asked for, as a
//! passage does, and is kept only when it fits them together (the writer's
//! filler, `fits_fresh`).

use sapling_srs::ItemSrs;

use crate::challenge::Challenge;
use crate::fits::{best_fit, fits_fresh, Serving};
use crate::help::HelpLevel;
use crate::kinds::{kind_of, Want, WireType};
use crate::model::{
    length_of, starting_skill, tuning, Aim, Evidence, Learner, Observation, MULTI_WORD,
};
use crate::pool::PoolRow;
use crate::rng::Rng;
use crate::serve::RomanizationMode;
use crate::sim::{synthetic, with_readings};
use crate::stream::{head, low_water_mark, next_pick, upcoming};
use crate::topup::{plan_top_up, Scope};
use crate::word::{by_id, Word};

const DAY: f64 = 86_400_000.0;
const START: f64 = 1_700_000_000_000.0;

fn word(id: usize, skill: f64) -> Word {
    Word {
        id: format!("w{id}"),
        term: format!("t{id}"),
        meaning: format!("m{id}"),
        romanization: None,
        srs: None,
        skill: Some(skill),
    }
}

/// A language without readings, as the default; one with readings under each
/// setting; and listening on top.
fn settings() -> Vec<(&'static str, Serving)> {
    let with = |readings: bool, mode: RomanizationMode, audio: bool| Serving {
        readings,
        romanization_mode: mode,
        audio,
        ..Serving::default()
    };
    vec![
        ("latin", Serving::default()),
        ("latin off", with(false, RomanizationMode::Off, false)),
        ("readings off", with(true, RomanizationMode::Off, false)),
        ("readings on", with(true, RomanizationMode::On, false)),
        (
            "readings adaptive",
            with(true, RomanizationMode::Adaptive, false),
        ),
        (
            "readings adaptive, heard",
            with(true, RomanizationMode::Adaptive, true),
        ),
    ]
}

/// How many rows about several words the writer kept, and how many it dropped.
#[derive(Debug, Default)]
struct Several {
    kept: usize,
    dropped: usize,
}

/// Every want written as a model might: `drift` words off the length asked
/// for, stamped with the length asked (as the resolver stamps it), with a
/// reading where the language has one, and a multi-cloze naming a second word
/// (`partner`) beside its own. A row is kept, as the filler keeps it, only
/// when it fits its words as written.
#[allow(clippy::too_many_arguments)]
fn fulfil(
    pool: &mut Vec<Option<PoolRow>>,
    wants: &[Want],
    words: &[Word],
    serving: &Serving,
    at: f64,
    drift: i32,
    partner: &mut dyn FnMut(&str) -> String,
    several: &mut Several,
) {
    let index = by_id(words);
    for want in wants {
        let id = format!("c{}", pool.len());
        let written = (i32::from(want.length) + drift).max(3);
        let mut items = vec![want.item.id.clone()];
        if want.kind.kind == WireType::MultiCloze {
            items.push(partner(&want.item.id));
        }
        let cited: Vec<&str> = items.iter().map(String::as_str).collect();
        let mut value = synthetic(want.kind.kind, &id, &cited, written as usize);
        if serving.readings {
            value = with_readings(value);
        }
        let mut challenge = Challenge::from_value(value).expect("a synthetic row parses");
        challenge.set_asked_length(f64::from(want.length));
        if items.len() > 1 {
            if !fits_fresh(&challenge, &index, serving) {
                several.dropped += 1;
                continue;
            }
            several.kept += 1;
        }
        pool.push(Some(PoolRow {
            challenge,
            generated_at: at,
            times_served: 0.0,
            last_served_at: None,
            reported: false,
            topic: None,
            correction: None,
        }));
    }
}

/// Rows written as the planner asked fit the words they were asked for, and
/// the planner then wants nothing more for them — at every skill and aim,
/// under every readings setting, however far the writing drifted from the
/// length asked for, and whatever word a passage paired its own with.
#[test]
fn rows_written_as_requested_are_served_and_want_nothing_more() {
    let mut several = Several::default();
    for (name, base) in settings() {
        for (aim, drift) in [(Aim::Easier, 0), (Aim::Normal, 4), (Aim::Harder, -3)] {
            let serving = Serving {
                aim,
                ..base.clone()
            };
            let words: Vec<Word> = (0..25).map(|i| word(i, -12.0 + i as f64)).collect();
            let mut pool = Vec::new();
            let mut draws = Rng::seeded(3);
            let wants = plan_top_up(
                &pool,
                &words,
                START,
                &serving,
                Scope::default(),
                &mut || draws.next_f64(),
            );
            assert!(!wants.is_empty());
            let mut pairs = Rng::seeded(5);
            let mut partner = |own: &str| loop {
                let other = format!("w{}", (pairs.next_f64() * 25.0) as usize);
                if other != own {
                    break other;
                }
            };
            fulfil(
                &mut pool,
                &wants,
                &words,
                &serving,
                START,
                drift,
                &mut partner,
                &mut several,
            );
            let index = by_id(&words);
            for row in pool.iter().flatten() {
                assert!(
                    best_fit(row, &index, &serving).is_some(),
                    "{name} {aim:?} {}",
                    row.challenge.id()
                );
            }
            let wanted: Vec<&str> = wants.iter().map(|w| w.item.id.as_str()).collect();
            let again = plan_top_up(
                &pool,
                &words,
                START,
                &serving,
                Scope::default(),
                &mut || 0.0,
            );
            assert!(
                again.iter().all(|w| !wanted.contains(&w.item.id.as_str())),
                "{name} {aim:?}"
            );
        }
    }
    // The pairing really was exercised, both ways.
    assert!(several.kept > 0 && several.dropped > 0, "{several:?}");
}

/// A learner practising daily, every answer folded into the model as the
/// app folds it, refill fulfilled as asked (the writing drifting in length,
/// passages pairing words) but only now and then, and never twice for a word
/// with nothing served since: whenever the head has nothing it has not been
/// asked for yet, and one refill gives it something; the pick is always the
/// head of the list.
fn no_word_waits_for_more_than_one_refill_under(name: &str, base: &Serving, days: usize) {
    let mut rng = Rng::seeded(11);
    // Skills from far under the easiest row to far over the hardest, with the
    // truth a little off what the model starts from.
    let mut words: Vec<Word> = (0..40)
        .map(|i| word(i, starting_skill() + 16.0 * (rng.next_f64() - 0.5)))
        .collect();
    let truth: Vec<f64> = words
        .iter()
        .map(|w| w.skill.unwrap() + rng.next_f64() - 0.5)
        .collect();
    // A plain exponential schedule stands in for FSRS: memory orders the words
    // and draws the outcomes, and decides nothing a row is picked by.
    let mut stability: Vec<Option<(f64, f64)>> = vec![None; words.len()];
    let mut pool: Vec<Option<PoolRow>> = Vec::new();
    let mut learner = Learner::default();
    for w in &words {
        learner.skills.insert(w.id.clone(), w.skill.unwrap());
    }
    let rates = tuning().rates;
    let mut blocked = 0;
    let mut several = Several::default();

    for day in 0..days {
        let mut now = START + day as f64 * DAY + 9.0 * 3_600_000.0;
        let mut served: Vec<String> = Vec::new();
        let mut asked: Vec<String> = Vec::new();
        for answer in 0..40 {
            now += 20_000.0;
            for (w, at) in stability.iter().enumerate() {
                if let Some((days, last)) = *at {
                    words[w].srs = Some(ItemSrs {
                        due: last + days * DAY,
                        retrievability: 0.9f64.powf((now - last) / (days * DAY)),
                        strength: 0.0,
                    });
                }
            }
            let serving = Serving {
                parts: learner.shared.clone(),
                ..base.clone()
            };
            let mark = low_water_mark(None, None);
            let drift = [0, 3, -2][answer % 3];
            let count = words.len();
            let mut refill = |pool: &mut Vec<Option<PoolRow>>,
                              asked: &mut Vec<String>,
                              several: &mut Several| {
                let scope = Scope {
                    served: &served,
                    asked,
                    limit: Some(mark),
                };
                let wants = plan_top_up(pool, &words, now, &serving, scope, &mut || rng.next_f64());
                let mut partner = |own: &str| loop {
                    let other = format!("w{}", (rng.next_f64() * count as f64) as usize);
                    if other != own {
                        break other;
                    }
                };
                fulfil(
                    pool,
                    &wants,
                    &words,
                    &serving,
                    now,
                    drift,
                    &mut partner,
                    several,
                );
                asked.extend(wants.into_iter().map(|w| w.item.id));
            };
            if answer % 7 == 0 {
                refill(&mut pool, &mut asked, &mut several);
            }
            let first = head(&pool, &words, now, &serving, &served, false).unwrap();
            let next = match first.next {
                Some(next) => next,
                None => {
                    blocked += 1;
                    assert!(
                        !asked.contains(&first.word),
                        "{name}, day {day}: blocked and already asked"
                    );
                    refill(&mut pool, &mut asked, &mut several);
                    next_pick(&pool, &words, now, &serving, &served).unwrap_or_else(|| {
                        panic!("{name}, day {day}: still blocked after a refill")
                    })
                }
            };
            let list = upcoming(&pool, &words, now, &serving, &served, mark);
            assert_eq!(list[0].next.as_ref(), Some(&next));
            // A head with something is never passed.
            let passing = head(&pool, &words, now, &serving, &served, true).unwrap();
            assert_eq!(
                (passing.next.as_ref(), passing.instead),
                (Some(&next), None)
            );

            // The answer: a draw from the truth, folded in as the app folds it.
            let row = pool[next.at].as_mut().unwrap();
            let id = row.challenge.id().to_owned();
            let items = row.challenge.item_ids().to_vec();
            let at: Vec<usize> = items
                .iter()
                .map(|item| words.iter().position(|w| w.id == *item).unwrap())
                .collect();
            let o = Observation {
                at: now,
                challenge_id: id.clone(),
                kind: kind_of(&row.challenge).unwrap(),
                help: HelpLevel::parse(&next.shown).unwrap(),
                length: length_of(&row.challenge),
                words: at
                    .iter()
                    .map(|&w| Evidence {
                        item_id: words[w].id.clone(),
                        memory: words[w].memory(),
                    })
                    .collect(),
                outcome: 0.0,
            };
            let skill = at.iter().map(|&w| truth[w]).sum::<f64>() / at.len() as f64;
            let memory: f64 = at.iter().map(|&w| words[w].memory()).product();
            let truly = crate::model::sigmoid(skill - learner.difficulty_of(&o));
            let correct = rng.next_f64() < memory * truly;
            let o = Observation {
                outcome: if correct { 1.0 } else { 0.0 },
                ..o
            };
            learner.learn(&o, &rates, MULTI_WORD);
            row.last_served_at = Some(now);
            row.times_served += 1.0;
            served.push(id);
            asked.retain(|a| !items.contains(a));
            for &w in &at {
                let days = stability[w].map_or(1.0, |(s, _)| s);
                let days = if correct {
                    days * 2.5
                } else {
                    (days * 0.3).max(0.01)
                };
                stability[w] = Some((days, now));
                words[w].skill = Some(learner.skill(&words[w].id));
            }
            for row in pool.iter_mut().flatten() {
                row.correction = learner.corrections.get(row.challenge.id()).copied();
            }
        }
    }
    assert!(
        blocked > 0,
        "{name}: the run never exercised a blocked head"
    );
    assert!(several.kept > 0, "{name}: no passage was ever written");
}

#[test]
fn no_word_waits_for_more_than_one_refill() {
    for (i, (name, serving)) in settings().into_iter().enumerate() {
        // The plain case runs longest; every other setting a shorter stretch.
        no_word_waits_for_more_than_one_refill_under(name, &serving, if i == 0 { 20 } else { 8 });
    }
}

/// When no batch can help the head, the stream passes it for the first word
/// further down the same list that has something — and only then.
#[test]
fn a_head_no_batch_can_help_is_passed_for_the_next_word_with_something() {
    let words: Vec<Word> = (0..3).map(|i| word(i, starting_skill())).collect();
    let serving = Serving::default();
    let mut pool = Vec::new();
    let wants = plan_top_up(
        &pool,
        &words[2..],
        START,
        &serving,
        Scope::default(),
        &mut || 0.0,
    );
    fulfil(
        &mut pool,
        &wants,
        &words,
        &serving,
        START,
        0,
        &mut |_| unreachable!("no passage for a new word"),
        &mut Several::default(),
    );
    let waiting = head(&pool, &words, START, &serving, &[], false).unwrap();
    assert_eq!(
        (waiting.word.as_str(), waiting.next.is_none()),
        ("w0", true)
    );
    let passed = head(&pool, &words, START, &serving, &[], true).unwrap();
    assert_eq!(passed.word, "w0");
    assert_eq!(passed.instead.as_deref(), Some("w2"));
    let row = pool[passed.next.unwrap().at].as_ref().unwrap();
    assert_eq!(row.challenge.item_ids(), ["w2"]);
    // Nothing anywhere: nothing to pass to.
    let empty = head(&[], &words, START, &serving, &[], true).unwrap();
    assert_eq!((empty.next, empty.instead), (None, None));
}
