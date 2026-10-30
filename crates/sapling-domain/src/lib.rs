//! Sapling's event log as a contract.
//!
//! The twenty event types and their payload schemas ([`events`]), the domain
//! types those payloads and the `Backend` reads carry ([`types`]), the
//! content objects events reference by hash and the ownership each event
//! declares over them ([`objects`]), and the
//! [`LocalDay`] seam through which a host says what calendar day a timestamp
//! falls on and where its local hour began ([`day`]). This crate knows nothing of SQL or of how the log is
//! stored or merged — that is `sapling-db` — so anything that reads, writes or
//! ships events can depend on the shapes alone.

#![forbid(unsafe_code)]

pub mod day;
pub mod events;
pub mod objects;
pub mod types;

pub use crate::day::{LocalDay, Utc};
