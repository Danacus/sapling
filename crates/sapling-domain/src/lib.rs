//! Sapling's event log as a contract.
//!
//! The seventeen event types and their payload schemas ([`events`]), the domain
//! types those payloads and the `Backend` reads carry ([`types`]), and the
//! [`LocalDay`] seam through which a host says what calendar day a timestamp
//! falls on ([`day`]). This crate knows nothing of SQL or of how the log is
//! stored or merged — that is `sapling-db` — so anything that reads, writes or
//! ships events can depend on the shapes alone.

#![forbid(unsafe_code)]

pub mod day;
pub mod events;
pub mod types;

pub use crate::day::{LocalDay, Utc};
