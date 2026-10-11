//! Shared grading values; each registered plugin owns its grading rule.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use sapling_domain::types::Verdict;

/// The numbered marker for one zero-based multi-cloze gap.
pub fn multi_cloze_marker(index: usize) -> String {
    format!("___{}___", index + 1)
}

/// One composite answer item's verdict, filed against that item's review.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct GapVerdict {
    pub item_id: String,
    pub verdict: Verdict,
}
