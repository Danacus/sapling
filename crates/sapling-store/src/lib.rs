//! What a native host lends `sapling-db`, and where it keeps it.
//!
//! The core owns no database, clock, calendar or id generator (see `core.md`);
//! the browser lends those through `src/lib/db/host.ts`, and this crate is the
//! same four facts read off an operating system instead: a SQLite *file* in a
//! directory through [`rusqlite_sql`] (the only rusqlite adapter, and the only
//! crate that links rusqlite), the system clock, the system time zone, and
//! UUID v4.
//!
//! It is its own crate, and free of Tauri, so that anything native opens the
//! database the same way: `sapling-desktop` hands it Tauri's app-data
//! directory, and a command-line tool pointed at that directory would open the
//! very same file. It knows nothing about who is calling — no command, no
//! window, no event — and speaks no protocol: [`CoreHandle::run`] hands a
//! closure the [`Core`] itself, and the desktop's JSON `dispatch` is
//! `sapling-protocol` called inside one such closure.
//!
//! ## Why a thread and not a `Mutex`
//!
//! [`Core`] is `!Send`: its `Sql`, clock, ids and calendar are plain boxed
//! trait objects, and they have to stay that way — the wasm host's `JsSql`
//! holds `js_sys::Function`, which can never be `Send`. So a `Mutex<Core>` in
//! Tauri's managed state does not compile, and the fix is the other way round:
//! one thread owns the core for its whole life and every call is a closure
//! posted to it. That also gives what the mutex was wanted for — calls arrive
//! from Tauri's command pool and are served strictly one at a time — plus a
//! deterministic close, since dropping the handle joins the thread and the
//! `Connection` is gone before [`CoreHandle::open`] can be called again on the
//! same file.
//!
//! What this thread does *not* decide is the order two calls arrive in. The
//! desktop's persistence commands are `async` and wait on `spawn_blocking` (see
//! `sapling-desktop`'s crate root), so several pool threads can be inside
//! [`CoreHandle::run`] at once and
//! whichever reaches the channel first is served first. The core thread then
//! runs them one at a time in that arrival order. Ordering a window cares about
//! — a read that must see the write before it — is the window's to keep, and
//! `src/lib/db/tauri.ts` keeps it by chaining every `invoke` behind the
//! previous one.
//!
//! ## A database that will not open is a screen, not a crash
//!
//! The browser's Worker answers its boot with `ready` or `bootError`, and the
//! layout turns the latter into a message the learner can read (`+layout.svelte`).
//! This host has no boot message — the window's first `dispatch` is its first
//! word — so the failure is kept instead: [`Database`] is what Tauri manages,
//! and it holds either the open core or the reason there is none. Every
//! command answers that reason as its `Err`, so the same layout shows the same
//! screen, and `setup` never returns an error that would end the process
//! before a window exists to say why.
//!
//! ## The device id is a file, not a row
//!
//! It is half of a review's identity (`reviews` is keyed `(itemId, at,
//! device)`), so it has to outlive every restart *and* `resetData`, which
//! empties the whole database including `meta`. A sibling file next to
//! `sapling.db` survives both, and keeps the host out of the core's tables.

#![forbid(unsafe_code)]

pub mod rusqlite_sql;

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Sender};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{Local, TimeZone};
use rusqlite::Connection;
use sapling_db::Core;
use sapling_domain::{LocalDay, Utc};

use crate::rusqlite_sql::RusqliteSql;
use uuid::Uuid;

/// The database, inside the app-data directory.
pub const DATABASE_FILE: &str = "sapling.db";

/// This installation's device id, beside it.
pub const DEVICE_ID_FILE: &str = "device-id";

const CLOSED: &str = "the database is closed";

/// The host's calendar: the operating system's time zone, formatted as
/// `src/lib/db/day.ts` formats it.
struct SystemZone;

impl LocalDay for SystemZone {
    fn local_day(&self, at: f64) -> String {
        // `new Date(at)` truncates towards zero before it does anything else.
        match Local.timestamp_millis_opt(at.trunc() as i64).single() {
            Some(local) => local.format("%Y-%m-%d").to_string(),
            // Only reachable for a timestamp outside chrono's range, which is
            // far outside JavaScript's. Answering something beats panicking.
            None => Utc.local_day(at),
        }
    }
}

fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_millis() as f64)
        .unwrap_or(0.0)
}

fn io_error(what: &str, error: io::Error) -> String {
    format!("{what}: {error}")
}

/// Reads this installation's device id, minting and persisting one on first run.
fn device_id(dir: &Path) -> Result<String, String> {
    let path = dir.join(DEVICE_ID_FILE);
    if let Ok(stored) = fs::read_to_string(&path) {
        let stored = stored.trim();
        if !stored.is_empty() {
            return Ok(stored.to_owned());
        }
    }
    let minted = Uuid::new_v4().to_string();
    fs::write(&path, &minted).map_err(|e| io_error("could not write the device id", e))?;
    Ok(minted)
}

/// Opens the core over `dir/sapling.db`, creating the directory if it is new.
fn open_core(dir: &Path) -> Result<Core, String> {
    fs::create_dir_all(dir).map_err(|e| io_error("could not create the data directory", e))?;
    let device_id = device_id(dir)?;
    let connection = Connection::open(dir.join(DATABASE_FILE))
        .map_err(|e| format!("could not open the database: {e}"))?;
    let sql = RusqliteSql::new(connection);
    // WAL, so a reader never blocks the writer and a hard kill leaves a
    // recoverable file. It is a property of the file, set once and kept.
    sql.connection()
        .pragma_update_and_check(None, "journal_mode", "WAL", |row| row.get::<_, String>(0))
        .map_err(|e| format!("could not switch the database to WAL: {e}"))?;
    // NORMAL beside it, which is what makes WAL worth having: at FULL — SQLite's
    // default — every commit fsyncs the WAL, and a session's Check writes three
    // or more of them back to back while the window waits. Under WAL, NORMAL is
    // still durable against an application crash (the WAL is a file, not a
    // buffer); what it gives up is the last transaction on a power cut or a
    // kernel panic, which is one answered challenge. Unlike `journal_mode` this
    // is a property of the *connection*, so it is set on every open.
    sql.connection()
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("could not set the database to synchronous=NORMAL: {e}"))?;
    // `PRAGMA synchronous = ...` answers nothing, so unlike `journal_mode` the
    // value has to be read back to know it took. 1 is NORMAL.
    let synchronous: i32 = sql
        .connection()
        .pragma_query_value(None, "synchronous", |row| row.get(0))
        .map_err(|e| format!("could not read back the database's synchronous mode: {e}"))?;
    if synchronous != 1 {
        return Err(format!(
            "the database stayed at synchronous={synchronous}, not NORMAL"
        ));
    }
    Core::open(
        Box::new(sql),
        device_id,
        now,
        || Uuid::new_v4().to_string(),
        SystemZone,
    )
    .map_err(|e| e.0)
}

/// One unit of work for the thread that owns the core.
type Task = Box<dyn FnOnce(&Core) + Send>;

/// The core, addressable from any thread.
pub struct CoreHandle {
    tasks: Option<Sender<Task>>,
    thread: Option<JoinHandle<()>>,
}

impl CoreHandle {
    /// Opens the database under `dir` and hands back a handle to it.
    ///
    /// Returns once the schema has been applied (and the log replayed, if the
    /// read tables were stale), so a caller that gets a handle has a core that
    /// is ready to answer.
    pub fn open(dir: &Path) -> Result<CoreHandle, String> {
        let dir: PathBuf = dir.to_path_buf();
        let (tasks, incoming) = channel::<Task>();
        let (opened, outcome) = channel::<Result<(), String>>();

        let thread = std::thread::Builder::new()
            .name("sapling-core".to_owned())
            .spawn(move || {
                let core = match open_core(&dir) {
                    Ok(core) => {
                        let _ = opened.send(Ok(()));
                        core
                    }
                    Err(error) => {
                        let _ = opened.send(Err(error));
                        return;
                    }
                };
                // Ends when the last handle drops and the channel closes,
                // which is what closes the SQLite connection.
                while let Ok(task) = incoming.recv() {
                    task(&core);
                }
            })
            .map_err(|e| io_error("could not start the database thread", e))?;

        match outcome.recv() {
            Ok(Ok(())) => Ok(CoreHandle {
                tasks: Some(tasks),
                thread: Some(thread),
            }),
            Ok(Err(error)) => Err(error),
            Err(_) => Err("the database thread stopped before it opened".to_owned()),
        }
    }

    /// Runs one closure against the core, on the core's thread, and waits for
    /// its answer. This is the whole surface: a caller speaks to [`Core`]
    /// directly, in whatever shape it wants — the desktop's JSON protocol, or a
    /// command-line tool's typed calls.
    pub fn run<T: Send + 'static>(
        &self,
        task: impl FnOnce(&Core) -> T + Send + 'static,
    ) -> Result<T, String> {
        let (reply, answer) = channel::<T>();
        let tasks = self.tasks.as_ref().ok_or_else(|| CLOSED.to_owned())?;
        tasks
            .send(Box::new(move |core| {
                let _ = reply.send(task(core));
            }))
            .map_err(|_| CLOSED.to_owned())?;
        answer.recv().map_err(|_| CLOSED.to_owned())
    }
}

impl Drop for CoreHandle {
    fn drop(&mut self) {
        // Closing the channel is what ends the loop; joining is what makes
        // "the file is closed" true by the time this returns.
        self.tasks.take();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// What the window can reach: the core, or the reason it could not be opened.
///
/// This is the state Tauri manages. Holding the failure rather than
/// propagating it out of `setup` is what turns "the app does not start" into
/// the boot-error screen every host shows; see the module header.
pub struct Database(Result<CoreHandle, String>);

impl Database {
    /// Opens the database under `dir`; a failure is kept, not returned.
    pub fn open(dir: &Path) -> Database {
        Database(
            CoreHandle::open(dir)
                .map_err(|error| format!("The database could not be opened: {error}")),
        )
    }

    /// The core, or the message every call answers when there is none.
    pub fn core(&self) -> Result<&CoreHandle, String> {
        self.0.as_ref().map_err(Clone::clone)
    }

    /// Why the database is not open — `None` when it is.
    pub fn error(&self) -> Option<&str> {
        self.0.as_ref().err().map(String::as_str)
    }
}
