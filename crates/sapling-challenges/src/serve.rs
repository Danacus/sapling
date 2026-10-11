//! Shared screen-building utilities used by challenge plugins.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The learner's romanization preference, which bounds available help levels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum RomanizationMode {
    On,
    Off,
    #[default]
    Adaptive,
}

/// Every answer position, then the first other positions in stored order.
pub(crate) fn select_positions(bank: usize, answers: &[usize], size: usize) -> Vec<usize> {
    let capped = size.max(answers.len()).min(bank);
    let mut selected = answers.to_vec();
    let mut index = 0;
    while selected.len() < capped && index < bank {
        if !selected.contains(&index) {
            selected.push(index);
        }
        index += 1;
    }
    selected.sort_unstable();
    selected
}

/// The stored tile positions containing every answer token and `count` extras.
pub(crate) fn visible_tiles(
    tiles: &[String],
    answer_tokens: &[String],
    count: usize,
) -> Vec<usize> {
    let mut remaining: HashMap<&str, usize> = HashMap::new();
    for token in answer_tokens {
        *remaining.entry(token.as_str()).or_default() += 1;
    }
    let mut answers = Vec::new();
    for (index, tile) in tiles.iter().enumerate() {
        if let Some(left) = remaining.get_mut(tile.as_str()).filter(|left| **left > 0) {
            *left -= 1;
            answers.push(index);
        }
    }
    select_positions(tiles.len(), &answers, answers.len() + count)
}
