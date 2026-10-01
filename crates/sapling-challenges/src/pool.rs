//! A pooled row and the two row-level questions the stream's one predicate
//! (`stream.rs`' `available`) asks of it: is it worth playing at all, and has
//! it rested.

use std::collections::HashSet;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::challenge::Challenge;
use crate::word::Word;

/// How long a served challenge rests before it is planned again: long enough
/// that the sentence is re-read rather than recognized.
pub const RESERVE_GAP: f64 = 3.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// A stored challenge with the pool's bookkeeping.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PoolRow {
    #[serde(flatten)]
    pub challenge: Challenge,
    /// Epoch ms the batch it came from was persisted.
    pub generated_at: f64,
    /// How many times it has been answered.
    pub times_served: f64,
    /// Epoch ms of the last answer; `null` while never served.
    pub last_served_at: Option<f64>,
    /// Flagged by the learner: excluded forever.
    pub reported: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub topic: Option<String>,
    /// How much harder (or, below zero, easier) this row has proved than its
    /// kind, help level and length predict — learned from its answers, absent
    /// until it has any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub correction: Option<f64>,
}

/// The pool as a host hands it over, a row that does not read as `None` — it
/// keeps its place, so a plan's positions still index the host's array.
pub fn lenient_rows<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<Option<PoolRow>>, D::Error> {
    let rows = Vec::<Value>::deserialize(deserializer)?;
    Ok(rows
        .into_iter()
        .map(|row| serde_json::from_value(row).ok())
        .collect())
}

pub fn known_ids(words: &[Word]) -> HashSet<&str> {
    words.iter().map(|word| word.id.as_str()).collect()
}

/// Not reported, and every word it exercises still exists.
pub fn is_playable(row: &PoolRow, known: &HashSet<&str>) -> bool {
    let ids = row.challenge.item_ids();
    !row.reported && !ids.is_empty() && ids.iter().all(|id| known.contains(id.as_str()))
}

/// Never served, or served at least [`RESERVE_GAP`] ago.
pub fn is_rested(row: &PoolRow, now: f64) -> bool {
    row.last_served_at
        .is_none_or(|served| now - served >= RESERVE_GAP)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_row_reads_its_bookkeeping_beside_its_challenge() {
        let row: PoolRow = serde_json::from_value(json!({
            "id": "c", "type": "cloze", "direction": "toTarget", "sentence": "a ___", "acceptedAnswers": ["b"],
            "itemIds": ["i"], "generatedAt": 5, "timesServed": 0, "lastServedAt": null, "reported": false, "topic": "t"
        }))
        .unwrap();
        assert_eq!(row.challenge.id(), "c");
        assert_eq!(row.topic.as_deref(), Some("t"));
        assert!(is_rested(&row, 0.0));
    }

    #[test]
    fn an_unreadable_row_keeps_its_place() {
        #[derive(Deserialize)]
        struct Pool {
            #[serde(deserialize_with = "lenient_rows")]
            pool: Vec<Option<PoolRow>>,
        }
        let pool: Pool = serde_json::from_value(json!({ "pool": [
            { "id": "x", "type": "dictation", "generatedAt": 0, "timesServed": 0, "lastServedAt": null, "reported": false },
            { "id": "c", "type": "cloze", "direction": "toTarget", "sentence": "a ___", "acceptedAnswers": ["b"],
              "itemIds": ["i"], "generatedAt": 0, "timesServed": 0, "lastServedAt": null, "reported": false }
        ] }))
        .unwrap();
        assert!(pool.pool[0].is_none());
        assert_eq!(pool.pool[1].as_ref().unwrap().challenge.id(), "c");
    }
}
