---
paths:
  - 'crates/sapling-desktop/**'
  - 'src/lib/db/tauri.ts'
---

# The desktop shell

Runbook: `docs/desktop.md`. **Status: a spike.** It runs, it persists, and it is
not shipped — nothing in the web build, the gates or CI depends on it.

- **`crates/sapling-desktop` is a host, and that is all it is.** It owns a file
  (`sapling.db` in Tauri's app-data directory), a device id, the system clock
  and the system time zone, and it hands all four to `sapling-core` through the
  `Sql`/`LocalDay` seams `core.md` describes. It contains **no merge rule, no
  read, and no SQL against the read tables** — the one statement it issues is
  `PRAGMA journal_mode = WAL`, which is a property of the file and not of the
  data. A behaviour that differs between the browser and the desktop is a bug
  in one of the two hosts; there is only one implementation of the rules.

- **The commands are exactly `WasmCore`'s surface**, name for name:
  `dispatch(method, args) -> Result<Option<String>, String>`, `commit_all`,
  `derived_schema_version`. No fourth command, and no new `Backend` method that
  the browser does not also have — the protocol is `src/lib/db/protocol.ts` and
  `dispatch.rs`, and adding to it is still the three edits `core.md` names.

- **One thread owns the core, and this is not a style choice.** `Core` is
  `!Send` — its `Sql`, clock, ids and calendar are plain boxed trait objects,
  and they must stay plain because the wasm host's `JsSql` holds a
  `js_sys::Function`, which can never be `Send`. So `Mutex<Core>` will not
  compile as Tauri managed state. `host.rs` instead spawns one thread that owns
  the core for its whole life and posts closures to it; that serialises calls
  arriving from Tauri's command pool, and dropping `CoreHandle` closes the
  channel and joins, so "the database is closed" is true by the time the drop
  returns.

- **The device id is a file, `device-id`, beside the database.** It is half of a
  review's identity (`reviews` is keyed `(itemId, at, device)`), so it must
  survive every restart *and* `resetData`, which empties the whole database,
  `meta` included. It is minted once with UUID v4 and never rewritten. There is
  no `init` handshake here — that exists because the browser's Worker cannot
  read `localStorage`, and this host has no such problem.

- **`src/lib/db/tauri.ts` is a transport, nothing more.** `client.ts` owns the
  proxy (`backendOver`, one `Transport` function) and `toPlain`; this module
  only carries a call and parses the answer, exactly as `host.ts`'s `directOf`
  does — `null` back from the command is `undefined`, because JSON cannot say
  it. `backend.ts` decides which transport by `__TAURI_INTERNALS__` on the
  window, and imports this module only when that is true, so a browser loads
  neither it nor `@tauri-apps/api`.

- **The crate is a workspace member but not a *default* member.** It links
  WebKitGTK, which only `nix develop .#desktop` provides, and `pnpm core:check`
  / `pnpm core:test` are a bare `cargo clippy`/`cargo test` in the *default*
  shell. Reach it with `-p sapling-desktop` (`pnpm desktop:check` does), and
  keep it rustfmt-clean — `cargo fmt --check` walks every member, default or
  not. New source files must be `git add`ed before nix can see them.
