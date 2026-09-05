//! Sapling's persistence core, in one crate.
//!
//! The same thing `src/lib/db/core.ts` is: the event log and the merge rules
//! that turn it into read tables, the spaced-repetition scheduler those rules
//! call, and every method the app's `Backend` protocol exposes. It is written
//! against a four-line [`Sql`] seam and never opens a database itself, so one
//! build of the rules can sit behind sqlite-wasm in a browser Worker, rusqlite
//! in a native shell, or any other SQLite a host provides.
//!
//! Fidelity to the TypeScript is the point, down to what JavaScript would
//! print: [`js`] formats numbers and JSON the way `JSON.stringify` does, so a
//! card or a payload this crate writes is byte for byte what the other core
//! writes. The golden fixtures under `src/lib/db/fixtures/` are the contract
//! both have to meet.

#![forbid(unsafe_code)]

pub mod core;
pub mod day;
pub mod events;
pub mod js;
pub mod materialize;
pub mod schema;
pub mod sql;
pub mod srs;
pub mod types;

#[cfg(feature = "sqlite")]
pub mod rusqlite_sql;

pub use crate::core::{Core, ReviewOutcome};
pub use crate::day::{LocalDay, Utc};
pub use crate::sql::{Error, Param, Result, Row, Sql, SqlValue};
