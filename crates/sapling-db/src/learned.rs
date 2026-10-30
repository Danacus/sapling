//! The difficulty model's ratings as derived data
//! (`docs/challenge-difficulty.md`), one row each in `difficultyParts`: the
//! challenge ratings, the stability scale and base every word shares, and
//! each kind's length slope, with their margins. A rating not stored is still
//! at its start.
//!
//! They are a function of the answers replayed in `(at, id)` order
//! (`sapling-challenges`' `replay.rs`), whatever order the events arrived in.
//! The common case — this device's newest answer — is learned on the spot.
//! Anything that could change an answer already folded marks the fold
//! **dirty** instead: an answer older than the newest one folded, a review
//! older than it (it changes a memory), a challenge or word arriving after
//! answers that name it, a word deleted from under them, an overturn of an
//! answer already in (`overturns`: the answer replays at the verdict it was
//! overturned to, wherever it sits in the log). A dirty fold is
//! replayed whole from the read tables once, when the transaction settles
//! ([`settle`]). Both paths run the same arithmetic in the same order, so they
//! land on the same numbers — which the golden fixtures' reverse-arrival and
//! export/import checks hold them to.

use sapling_challenges::ratings::{Ratings, StoredRating};
use sapling_challenges::replay::{
    observations, ReplayInput, ReplayItem, ReplayResult, ReplayReview,
};
use sapling_challenges::Challenge;
use sapling_domain::types::{ChallengeResult, Verdict};

use crate::sql::{Param, Result, Row, Sql};

fn placeholders(count: usize) -> String {
    vec!["?"; count].join(", ")
}

/// The newest answer folded so far, by `(at, id)`, and whether a replay is owed.
struct State {
    watermark: Option<(f64, String)>,
    dirty: bool,
}

fn state(sql: &dyn Sql) -> Result<State> {
    let rows = sql.query(
        "SELECT at, resultId, dirty FROM difficultyFold WHERE id = 1",
        &[],
    )?;
    let Some(row) = rows.first() else {
        return Ok(State {
            watermark: None,
            dirty: false,
        });
    };
    let watermark = match (row.opt_f64("at")?, row.opt_text("resultId")?) {
        (Some(at), Some(id)) => Some((at, id.to_owned())),
        _ => None,
    };
    Ok(State {
        watermark,
        dirty: row.f64("dirty")? != 0.0,
    })
}

fn write_state(sql: &dyn Sql, state: &State) -> Result<()> {
    let (at, id) = match &state.watermark {
        Some((at, id)) => (Some(*at), Some(id.as_str())),
        None => (None, None),
    };
    sql.exec(
        "INSERT OR REPLACE INTO difficultyFold (id, at, resultId, dirty) VALUES (1, ?, ?, ?)",
        &[
            Param::opt_number(at),
            Param::opt_text(id),
            Param::flag(state.dirty),
        ],
    )
}

/// Owes a full replay at the next [`settle`].
pub fn mark_dirty(sql: &dyn Sql) -> Result<()> {
    let mut current = state(sql)?;
    if current.dirty {
        return Ok(());
    }
    current.dirty = true;
    write_state(sql, &current)
}

/// Whether an answer already folded names this word.
fn answered(sql: &dyn Sql, item_id: &str) -> Result<bool> {
    // Ids are quoted in the stored JSON, so a quoted match cannot hit a prefix.
    let quoted = format!("%\"{}\"%", item_id.replace('%', "\\%").replace('_', "\\_"));
    Ok(!sql
        .query(
            "SELECT 1 FROM results r JOIN challenges c ON c.id = r.challengeId
             WHERE c.content LIKE ? ESCAPE '\\' LIMIT 1",
            &[Param::text(quoted)],
        )?
        .is_empty())
}

/// A review at `at` changes the memory of every answer after it.
pub fn on_review(sql: &dyn Sql, at: f64) -> Result<()> {
    match state(sql)?.watermark {
        Some((newest, _)) if at < newest => mark_dirty(sql),
        _ => Ok(()),
    }
}

/// A challenge that lands after its answers makes them count.
pub fn on_challenge_added(sql: &dyn Sql, challenge_id: &str) -> Result<()> {
    let answered = !sql
        .query(
            "SELECT 1 FROM results WHERE challengeId = ? LIMIT 1",
            &[Param::text(challenge_id)],
        )?
        .is_empty();
    if answered {
        mark_dirty(sql)
    } else {
        Ok(())
    }
}

/// A word that lands after its answers, or leaves from under them.
pub fn on_item_changed(sql: &dyn Sql, item_id: &str) -> Result<()> {
    if answered(sql, item_id)? {
        mark_dirty(sql)
    } else {
        Ok(())
    }
}

/// An overturn changes the verdict of an answer that may be folded already;
/// one that lands before its answer is read by [`on_result`] instead.
pub fn on_overturn(sql: &dyn Sql, challenge_id: &str, answered_at: f64) -> Result<()> {
    let there = !sql
        .query(
            "SELECT 1 FROM results WHERE challengeId = ? AND at = ? LIMIT 1",
            &[Param::text(challenge_id), Param::number(answered_at)],
        )?
        .is_empty();
    if there {
        mark_dirty(sql)
    } else {
        Ok(())
    }
}

/// The verdict an answer replays at: what an overturn made it, else its own.
fn overturned(sql: &dyn Sql, result: &ChallengeResult) -> Result<Option<Verdict>> {
    let rows = sql.query(
        "SELECT verdict FROM overturns WHERE challengeId = ? AND answeredAt = ?",
        &[Param::text(&result.challenge_id), Param::number(result.at)],
    )?;
    Ok(match rows.first() {
        Some(row) => verdict_of(row.text("verdict")?),
        None => None,
    })
}

fn rating_of(row: &Row) -> Result<StoredRating> {
    Ok(StoredRating {
        key: row.text("key")?.to_owned(),
        value: row.f64("value")?,
        margin: row.f64("margin")?,
        start_margin: row.f64("startMargin")?,
        at: row.f64("at")?,
        answers: row.f64("answers")? as u32,
    })
}

/// The stored ratings under these keys.
fn ratings_of(sql: &dyn Sql, keys: &[String]) -> Result<Vec<StoredRating>> {
    let params: Vec<Param> = keys.iter().map(Param::text).collect();
    sql.query(
        &format!(
            "SELECT key, value, margin, startMargin, at, answers FROM difficultyParts
             WHERE key IN ({})",
            placeholders(keys.len())
        ),
        &params,
    )?
    .iter()
    .map(rating_of)
    .collect()
}

fn reviews_of(rows: &[Row]) -> Result<Vec<ReplayReview>> {
    rows.iter()
        .map(|row| {
            Ok(ReplayReview {
                item_id: row.text("itemId")?.to_owned(),
                at: row.f64("at")?,
                grade: row.f64("grade")?,
                device: row.text("device")?.to_owned(),
            })
        })
        .collect()
}

fn verdict_of(text: &str) -> Option<Verdict> {
    serde_json::from_value(serde_json::Value::String(text.to_owned())).ok()
}

/// A newly materialized answer: learned now when it is the newest, otherwise
/// left to the replay it makes owed.
pub fn on_result(sql: &dyn Sql, id: &str, result: &ChallengeResult) -> Result<()> {
    let mut current = state(sql)?;
    let newest = current.watermark.as_ref().is_none_or(|(at, newest)| {
        result
            .at
            .total_cmp(at)
            .then_with(|| id.cmp(newest.as_str()))
            .is_gt()
    });
    if !newest {
        return mark_dirty(sql);
    }
    current.watermark = Some((result.at, id.to_owned()));
    write_state(sql, &current)?;
    if current.dirty {
        return Ok(());
    }

    let Some(row) = sql
        .query(
            "SELECT content FROM challenges WHERE id = ?",
            &[Param::text(&result.challenge_id)],
        )?
        .into_iter()
        .next()
    else {
        return Ok(());
    };
    let Ok(challenge) = Challenge::from_value(serde_json::from_str(row.text("content")?)?) else {
        return Ok(());
    };
    let ids: Vec<String> = challenge.item_ids().to_vec();
    if ids.is_empty() {
        return Ok(());
    }
    let params: Vec<Param> = ids.iter().map(Param::text).collect();
    let items = sql.query(
        &format!(
            "SELECT id, introducedAt FROM items WHERE id IN ({})",
            placeholders(ids.len())
        ),
        &params,
    )?;
    let reviews = sql.query(
        &format!(
            "SELECT itemId, at, grade, device FROM reviews WHERE itemId IN ({})",
            placeholders(ids.len())
        ),
        &params,
    )?;
    let input = ReplayInput {
        items: items
            .iter()
            .map(|row| {
                Ok(ReplayItem {
                    id: row.text("id")?.to_owned(),
                    introduced_at: row.f64("introducedAt")?,
                })
            })
            .collect::<Result<_>>()?,
        reviews: reviews_of(&reviews)?,
        challenges: [(result.challenge_id.clone(), challenge)].into(),
        results: vec![ReplayResult {
            id: id.to_owned(),
            challenge_id: result.challenge_id.clone(),
            verdict: overturned(sql, result)?.unwrap_or(result.verdict),
            at: result.at,
            shown: result.shown.clone(),
        }],
    };
    let Some(observation) = observations(&input).into_iter().next() else {
        return Ok(());
    };

    // Only the ratings this answer is made of move.
    let empty = Ratings::default();
    let keys: Vec<String> = empty
        .terms(&observation)
        .iter()
        .map(|t| t.key.stored())
        .collect();
    let mut ratings = Ratings::from_stored(&ratings_of(sql, &keys)?);
    ratings.learn(&observation);
    write_ratings(sql, &ratings)
}

/// Writes every rating held over what is stored.
fn write_ratings(sql: &dyn Sql, ratings: &Ratings) -> Result<()> {
    for r in ratings.stored() {
        sql.exec(
            "INSERT OR REPLACE INTO difficultyParts (key, value, margin, startMargin, at, answers)
             VALUES (?, ?, ?, ?, ?, ?)",
            &[
                Param::text(r.key),
                Param::number(r.value),
                Param::number(r.margin),
                Param::number(r.start_margin),
                Param::number(r.at),
                Param::number(f64::from(r.answers)),
            ],
        )?;
    }
    Ok(())
}

/// Replays every answer from the read tables and writes the result over
/// whatever was learned before.
pub fn refold(sql: &dyn Sql) -> Result<()> {
    sql.exec("DELETE FROM difficultyParts", &[])?;

    let items = sql
        .query("SELECT id, introducedAt FROM items", &[])?
        .iter()
        .map(|row| {
            Ok(ReplayItem {
                id: row.text("id")?.to_owned(),
                introduced_at: row.f64("introducedAt")?,
            })
        })
        .collect::<Result<_>>()?;
    let reviews = reviews_of(&sql.query("SELECT itemId, at, grade, device FROM reviews", &[])?)?;
    let challenges = sql
        .query(
            "SELECT id, content FROM challenges
             WHERE id IN (SELECT DISTINCT challengeId FROM results)",
            &[],
        )?
        .iter()
        .filter_map(|row| {
            let id = row.text("id").ok()?.to_owned();
            let value = serde_json::from_str(row.text("content").ok()?).ok()?;
            Some((id, Challenge::from_value(value).ok()?))
        })
        .collect();
    let rows = sql.query(
        "SELECT r.id AS id, r.challengeId AS challengeId,
                COALESCE(o.verdict, r.verdict) AS verdict, r.at AS at, r.shown AS shown
         FROM results r
         LEFT JOIN overturns o ON o.challengeId = r.challengeId AND o.answeredAt = r.at",
        &[],
    )?;
    let mut results = Vec::with_capacity(rows.len());
    for row in &rows {
        let Some(verdict) = verdict_of(row.text("verdict")?) else {
            continue;
        };
        results.push(ReplayResult {
            id: row.text("id")?.to_owned(),
            challenge_id: row.text("challengeId")?.to_owned(),
            verdict,
            at: row.f64("at")?,
            shown: row.opt_text("shown")?.map(str::to_owned),
        });
    }
    let watermark = results
        .iter()
        .max_by(|a, b| a.at.total_cmp(&b.at).then_with(|| a.id.cmp(&b.id)))
        .map(|r| (r.at, r.id.clone()));

    let mut ratings = Ratings::default();
    for o in observations(&ReplayInput {
        items,
        reviews,
        challenges,
        results,
    }) {
        ratings.learn(&o);
    }
    write_ratings(sql, &ratings)?;
    write_state(
        sql,
        &State {
            watermark,
            dirty: false,
        },
    )
}

/// Pays a replay the transaction made owed; a no-op otherwise.
pub fn settle(sql: &dyn Sql) -> Result<()> {
    if state(sql)?.dirty {
        refold(sql)
    } else {
        Ok(())
    }
}

/// Every rating as learned; a key not listed is at its start.
pub fn read_ratings(sql: &dyn Sql) -> Result<Vec<StoredRating>> {
    sql.query(
        "SELECT key, value, margin, startMargin, at, answers FROM difficultyParts ORDER BY key",
        &[],
    )?
    .iter()
    .map(rating_of)
    .collect()
}
