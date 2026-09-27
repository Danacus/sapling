//! Sapling's database: the event log stored, merged into read tables, and read
//! back.
//!
//! The DDL, the merge rules that fold each event (`sapling-domain`'s schemas)
//! into the read model, and every method the app's `Backend` protocol exposes,
//! as methods on [`Core`]; the spaced-repetition scheduler those rules call is
//! `sapling-srs`, and the by-name JSON surface over `Core` is `sapling-protocol`.
//! It is written against a four-line [`Sql`] seam and never opens a database
//! itself, so one build of the rules can sit behind sqlite-wasm in a browser
//! Worker, rusqlite in a native shell (`sapling-store`), or any other SQLite a
//! host provides.
//!
//! JSON goes out through serde_json and nothing else. The golden fixtures under
//! `src/lib/db/fixtures/` are the contract: they compare values, not bytes, so
//! how a number prints is not part of it.

#![forbid(unsafe_code)]

pub mod core;
pub mod materialize;
pub mod schema;
pub mod sql;

pub use crate::core::{Core, ReviewOutcome};
pub use crate::sql::{Error, Param, Result, Row, Sql, SqlValue};
