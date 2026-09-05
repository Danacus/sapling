//! The [`Sql`] seam over rusqlite — the adapter a native host uses, and the
//! one the crate's own tests run the golden fixtures through.
//!
//! Behind the `sqlite` feature, so a wasm build that borrows the browser's
//! sqlite-wasm through its own adapter never links a second SQLite.

use rusqlite::types::{Value as SqliteValue, ValueRef};
use rusqlite::{params_from_iter, Connection};

use crate::sql::{Error, Param, Result, Row, Sql, SqlValue};

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
        RusqliteSql { conn }
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

fn sqlite_error(error: rusqlite::Error) -> Error {
    Error(error.to_string())
}

fn to_sqlite(param: &Param) -> SqliteValue {
    match param {
        Param::Null => SqliteValue::Null,
        Param::Integer(i) => SqliteValue::Integer(*i),
        Param::Real(f) => SqliteValue::Real(*f),
        Param::Text(s) => SqliteValue::Text(s.clone()),
    }
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

impl Sql for RusqliteSql {
    fn exec(&self, sql: &str, params: &[Param]) -> Result<()> {
        if params.is_empty() {
            // A script, possibly of several statements — the DDL, `BEGIN`, a `DELETE`.
            self.conn.execute_batch(sql).map_err(sqlite_error)
        } else {
            self.conn
                .execute(sql, params_from_iter(params.iter().map(to_sqlite)))
                .map(|_| ())
                .map_err(sqlite_error)
        }
    }

    fn query(&self, sql: &str, params: &[Param]) -> Result<Vec<Row>> {
        let mut statement = self.conn.prepare(sql).map_err(sqlite_error)?;
        let names: Vec<String> = statement
            .column_names()
            .iter()
            .map(|n| n.to_string())
            .collect();
        let mut rows = statement
            .query(params_from_iter(params.iter().map(to_sqlite)))
            .map_err(sqlite_error)?;
        let mut out = Vec::new();
        while let Some(row) = rows.next().map_err(sqlite_error)? {
            let columns = names
                .iter()
                .enumerate()
                .map(|(i, name)| {
                    Ok((
                        name.clone(),
                        from_sqlite(row.get_ref(i).map_err(sqlite_error)?),
                    ))
                })
                .collect::<Result<Vec<_>>>()?;
            out.push(Row::new(columns));
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
}
