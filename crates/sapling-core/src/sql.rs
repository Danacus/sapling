//! The seam: synchronous SQLite, as an `exec`/`query` pair.
//!
//! Every rule in this crate is written against [`Sql`] and nothing else. The
//! crate never opens a database; a host hands it one, and a host is free to
//! back it with sqlite-wasm, rusqlite (see `rusqlite_sql`), or anything that
//! speaks SQLite's dialect.
//!
//! Numbers bind the way sqlite-wasm binds a JavaScript `number`: an integral
//! value as an `INTEGER`, anything else as a `REAL`. That keeps the stored
//! bytes — and SQLite's own `max`/`coalesce` arithmetic over them — identical
//! whichever core wrote the row.

use std::fmt;
use std::sync::Arc;

/// One bound parameter.
#[derive(Debug, Clone, PartialEq)]
pub enum Param {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
}

impl Param {
    /// A JavaScript `number`, bound as sqlite-wasm would bind it.
    pub fn number(x: f64) -> Param {
        if x.is_finite() && x.fract() == 0.0 && x.abs() < 9.0e18 {
            Param::Integer(x as i64)
        } else {
            Param::Real(x)
        }
    }

    pub fn text(s: impl Into<String>) -> Param {
        Param::Text(s.into())
    }

    /// `value ?? null`.
    pub fn opt_text(s: Option<&str>) -> Param {
        match s {
            Some(s) => Param::Text(s.to_owned()),
            None => Param::Null,
        }
    }

    /// `value ?? null`, for a number.
    pub fn opt_number(x: Option<f64>) -> Param {
        match x {
            Some(x) => Param::number(x),
            None => Param::Null,
        }
    }

    /// `1`/`0`, which is how the read tables store a boolean.
    pub fn flag(b: bool) -> Param {
        Param::Integer(if b { 1 } else { 0 })
    }
}

impl From<&str> for Param {
    fn from(s: &str) -> Self {
        Param::Text(s.to_owned())
    }
}

impl From<String> for Param {
    fn from(s: String) -> Self {
        Param::Text(s)
    }
}

impl From<f64> for Param {
    fn from(x: f64) -> Self {
        Param::number(x)
    }
}

impl From<i64> for Param {
    fn from(x: i64) -> Self {
        Param::Integer(x)
    }
}

/// One cell, as SQLite typed it.
#[derive(Debug, Clone, PartialEq)]
pub enum SqlValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
}

/// One result row: the columns in `SELECT` order, by name.
///
/// The names live beside the values rather than in them, and are shared: a
/// statement names its columns once and every row it returns points at that one
/// list. A thousand-row page therefore allocates one header, not one `String`
/// per cell — and `Arc`, not `Rc`, so a `Row` stays as `Send` as its values are.
#[derive(Debug, Clone, PartialEq)]
pub struct Row {
    names: Arc<[String]>,
    values: Vec<SqlValue>,
}

impl Row {
    pub fn new(columns: Vec<(String, SqlValue)>) -> Row {
        let (names, values): (Vec<String>, Vec<SqlValue>) = columns.into_iter().unzip();
        Row {
            names: names.into(),
            values,
        }
    }

    /// One row of a batch that already knows its column names — see
    /// [`Row::new`] for the one-off case.
    pub fn with_names(names: Arc<[String]>, values: Vec<SqlValue>) -> Row {
        Row { names, values }
    }

    fn index_of(&self, name: &str) -> Option<usize> {
        self.names.iter().position(|column| column == name)
    }

    pub fn get(&self, name: &str) -> Result<&SqlValue> {
        self.index_of(name)
            .and_then(|index| self.values.get(index))
            .ok_or_else(|| Error(format!("no column `{name}` in row")))
    }

    /// Whether the query returned this column at all — `SELECT` lists differ.
    pub fn has(&self, name: &str) -> bool {
        self.index_of(name).is_some()
    }

    /// A `NOT NULL` number, `INTEGER` or `REAL`.
    pub fn f64(&self, name: &str) -> Result<f64> {
        self.opt_f64(name)?
            .ok_or_else(|| Error(format!("column `{name}` is NULL")))
    }

    pub fn opt_f64(&self, name: &str) -> Result<Option<f64>> {
        match self.get(name)? {
            SqlValue::Null => Ok(None),
            SqlValue::Integer(i) => Ok(Some(*i as f64)),
            SqlValue::Real(f) => Ok(Some(*f)),
            SqlValue::Text(_) => Err(Error(format!("column `{name}` is TEXT, not a number"))),
        }
    }

    /// A `NOT NULL` text column.
    pub fn text(&self, name: &str) -> Result<&str> {
        self.opt_text(name)?
            .ok_or_else(|| Error(format!("column `{name}` is NULL")))
    }

    pub fn opt_text(&self, name: &str) -> Result<Option<&str>> {
        match self.get(name)? {
            SqlValue::Null => Ok(None),
            SqlValue::Text(s) => Ok(Some(s.as_str())),
            other => Err(Error(format!("column `{name}` is {other:?}, not TEXT"))),
        }
    }
}

/// Anything that stops a method: a SQLite error, a row that will not parse, a
/// scheduler handed a state it cannot fold. Carries the message and nothing else.
#[derive(Debug, Clone, PartialEq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error(e.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

/// Synchronous SQLite. A statement either runs or returns rows.
pub trait Sql {
    /// Runs one statement — or, with no parameters, a whole script such as the DDL.
    fn exec(&self, sql: &str, params: &[Param]) -> Result<()>;
    /// Runs one statement and returns every row it produced.
    fn query(&self, sql: &str, params: &[Param]) -> Result<Vec<Row>>;
}

impl<S: Sql + ?Sized> Sql for &S {
    fn exec(&self, sql: &str, params: &[Param]) -> Result<()> {
        (**self).exec(sql, params)
    }

    fn query(&self, sql: &str, params: &[Param]) -> Result<Vec<Row>> {
        (**self).query(sql, params)
    }
}

impl<S: Sql + ?Sized> Sql for Box<S> {
    fn exec(&self, sql: &str, params: &[Param]) -> Result<()> {
        (**self).exec(sql, params)
    }

    fn query(&self, sql: &str, params: &[Param]) -> Result<Vec<Row>> {
        (**self).query(sql, params)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integral_numbers_bind_as_integers() {
        assert_eq!(
            Param::number(1710061260000.0),
            Param::Integer(1710061260000)
        );
        assert_eq!(Param::number(0.0), Param::Integer(0));
        assert_eq!(Param::number(-3.0), Param::Integer(-3));
        assert_eq!(Param::number(2.5), Param::Real(2.5));
    }

    #[test]
    fn rows_sharing_a_header_read_like_rows_that_own_one() {
        let names: Arc<[String]> = vec!["id".to_owned(), "at".to_owned()].into();
        let shared = Row::with_names(
            Arc::clone(&names),
            vec![SqlValue::Text("a".into()), SqlValue::Integer(7)],
        );
        let owned = Row::new(vec![
            ("id".to_owned(), SqlValue::Text("a".into())),
            ("at".to_owned(), SqlValue::Integer(7)),
        ]);
        assert_eq!(shared, owned);
        assert_eq!(shared.text("id").unwrap(), "a");
        assert_eq!(shared.f64("at").unwrap(), 7.0);
        assert!(shared.has("at"));
        assert!(!shared.has("device"));
        assert!(shared.get("device").is_err());
    }
}
