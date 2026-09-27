//! Sapling's persistence core, in one crate.
//!
//! The event log and the merge rules that turn it into read tables, and every
//! method the app's `Backend` protocol exposes; the spaced-repetition scheduler
//! those rules call is `sapling-srs`. It is written against a four-line [`Sql`]
//! seam and never opens a database itself, so one build of the rules can sit
//! behind sqlite-wasm in a browser Worker, rusqlite in a native shell, or any
//! other SQLite a host provides.
//!
//! JSON goes out through serde_json and nothing else. The golden fixtures under
//! `src/lib/db/fixtures/` are the contract: they compare values, not bytes, so
//! how a number prints is not part of it.

#![forbid(unsafe_code)]

pub mod core;
pub mod day;
pub mod dispatch;
pub mod events;
pub mod materialize;
pub mod schema;
pub mod sql;
pub mod types;

#[cfg(feature = "sqlite")]
pub mod rusqlite_sql;

pub use crate::core::{Core, ReviewOutcome};
pub use crate::day::{LocalDay, Utc};
pub use crate::sql::{Error, Param, Result, Row, Sql, SqlValue};
