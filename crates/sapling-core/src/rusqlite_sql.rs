//! The [`Sql`] seam over rusqlite — the adapter a native host uses, and the
//! one the crate's own tests run the golden fixtures through.
//!
//! Behind the `sqlite` feature, so a wasm build that borrows the browser's
//! sqlite-wasm through its own adapter never links a second SQLite.

use std::sync::Arc;

use rusqlite::types::{ToSqlOutput, ValueRef};
use rusqlite::{params_from_iter, Connection};

use crate::sql::{Error, Param, Result, Row, Sql, SqlValue};

/// How many compiled statements the connection keeps.
///
/// The core issues around seventy fixed statement shapes, plus a few whose text
/// varies with the call — an `IN (?, ?, …)` as wide as the id list, an `UPDATE`
/// naming whichever fields a patch carries. This is comfortably above the fixed
/// set, so the hot ones (one `SELECT` and three to six writes per event
/// materialised) are never the ones a widening `IN` list evicts.
const STATEMENT_CACHE: usize = 128;

pub struct RusqliteSql {
    conn: Connection,
}

impl RusqliteSql {
    /// A fresh in-memory database — the fixtures' starting point.
    pub fn in_memory() -> Result<RusqliteSql> {
        Connection::open_in_memory()
            .map(RusqliteSql::new)
            .map_err(sqlite_error)
    }

    pub fn new(conn: Connection) -> RusqliteSql {
        conn.set_prepared_statement_cache_capacity(STATEMENT_CACHE);
        RusqliteSql { conn }
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

fn sqlite_error(error: rusqlite::Error) -> Error {
    Error(error.to_string())
}

/// A parameter as SQLite will bind it — borrowed, because the caller owns the
/// text for the whole call and a JSON payload is not worth copying.
fn to_sqlite(param: &Param) -> ToSqlOutput<'_> {
    ToSqlOutput::Borrowed(match param {
        Param::Null => ValueRef::Null,
        Param::Integer(i) => ValueRef::Integer(*i),
        Param::Real(f) => ValueRef::Real(*f),
        Param::Text(s) => ValueRef::Text(s.as_bytes()),
    })
}

fn from_sqlite(value: ValueRef<'_>) -> SqlValue {
    match value {
        ValueRef::Null => SqlValue::Null,
        ValueRef::Integer(i) => SqlValue::Integer(i),
        ValueRef::Real(f) => SqlValue::Real(f),
        ValueRef::Text(bytes) => SqlValue::Text(String::from_utf8_lossy(bytes).into_owned()),
        // The schema stores no blobs; one would be a foreign row.
        ValueRef::Blob(_) => SqlValue::Null,
    }
}

/// Every statement is compiled once and kept: the core issues the same few
/// dozen shapes over and over — three to six writes for every event
/// materialised — and recompiling them per call was most of what a pulled page
/// of a thousand events spent its time on. SQLite re-prepares a cached
/// statement itself when the schema under it changes, which is what makes the
/// drop-and-rebuild in `open_schema` safe.
impl Sql for RusqliteSql {
    fn exec(&self, sql: &str, params: &[Param]) -> Result<()> {
        if params.is_empty() {
            // A script, possibly of several statements — the DDL, `BEGIN`, a
            // `DELETE`. A prepared statement is one statement, so this path
            // cannot be cached without silently dropping the rest of the script.
            return self.conn.execute_batch(sql).map_err(sqlite_error);
        }
        self.conn
            .prepare_cached(sql)
            .map_err(sqlite_error)?
            .execute(params_from_iter(params.iter().map(to_sqlite)))
            .map(|_| ())
            .map_err(sqlite_error)
    }

    fn query(&self, sql: &str, params: &[Param]) -> Result<Vec<Row>> {
        let mut statement = self.conn.prepare_cached(sql).map_err(sqlite_error)?;
        // Named once for the whole result, and shared by every row in it.
        let names: Arc<[String]> = statement
            .column_names()
            .iter()
            .map(|name| (*name).to_owned())
            .collect();
        let mut rows = statement
            .query(params_from_iter(params.iter().map(to_sqlite)))
            .map_err(sqlite_error)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(sqlite_error)? {
            let values = (0..names.len())
                .map(|i| Ok(from_sqlite(row.get_ref(i).map_err(sqlite_error)?)))
                .collect::<Result<Vec<_>>>()?;
            out.push(Row::with_names(Arc::clone(&names), values));
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_value_kind() {
        let sql = RusqliteSql::in_memory().unwrap();
        sql.exec("CREATE TABLE t (i INTEGER, r REAL, s TEXT, n TEXT)", &[])
            .unwrap();
        sql.exec(
            "INSERT INTO t VALUES (?, ?, ?, ?)",
            &[
                Param::number(3.0),
                Param::number(2.5),
                Param::text("x"),
                Param::Null,
            ],
        )
        .unwrap();
        let rows = sql.query("SELECT * FROM t", &[]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("i").unwrap(), &SqlValue::Integer(3));
        assert_eq!(rows[0].get("r").unwrap(), &SqlValue::Real(2.5));
        assert_eq!(rows[0].text("s").unwrap(), "x");
        assert_eq!(rows[0].opt_text("n").unwrap(), None);
    }

    #[test]
    fn a_repeated_statement_rebinds_its_parameters() {
        let sql = RusqliteSql::in_memory().unwrap();
        sql.exec("CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER)", &[])
            .unwrap();
        for (id, n) in [("a", 1.0), ("b", 2.0)] {
            sql.exec(
                "INSERT INTO t (id, n) VALUES (?, ?)",
                &[Param::text(id), Param::number(n)],
            )
            .unwrap();
        }
        for (id, n) in [("a", 1), ("b", 2)] {
            let rows = sql
                .query("SELECT n FROM t WHERE id = ?", &[Param::text(id)])
                .unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].get("n").unwrap(), &SqlValue::Integer(n));
        }
    }

    /// `open_schema` drops and recreates every derived table when the version
    /// moves; a statement compiled against the old one has to survive that.
    #[test]
    fn a_cached_statement_survives_its_table_being_rebuilt() {
        let sql = RusqliteSql::in_memory().unwrap();
        sql.exec("CREATE TABLE t (id TEXT PRIMARY KEY)", &[])
            .unwrap();
        sql.exec("INSERT INTO t (id) VALUES (?)", &[Param::text("a")])
            .unwrap();
        assert_eq!(sql.query("SELECT id FROM t", &[]).unwrap().len(), 1);

        sql.exec(
            "DROP TABLE t; CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER);",
            &[],
        )
        .unwrap();
        sql.exec("INSERT INTO t (id) VALUES (?)", &[Param::text("b")])
            .unwrap();
        let rows = sql.query("SELECT id FROM t", &[]).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text("id").unwrap(), "b");
    }

    #[test]
    fn a_parameterless_exec_still_runs_a_whole_script() {
        let sql = RusqliteSql::in_memory().unwrap();
        sql.exec(
            "CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);",
            &[],
        )
        .unwrap();
        let rows = sql.query("SELECT n FROM t ORDER BY n", &[]).unwrap();
        assert_eq!(rows.len(), 2);
    }
}
