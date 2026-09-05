# Desktop (Tauri v2) — a spike

Contracts: `.claude/rules/desktop.md`, `.claude/rules/core.md`.
Code: `crates/sapling-desktop/`, `src/lib/db/tauri.ts`.

**This is a spike, not a product.** It exists to answer one question — can the
Rust persistence core run natively over a SQLite file behind the *existing*
domain protocol, with the same SvelteKit app on top? It can, and the app boots
to onboarding through it. Nothing in the web build, the gates or CI depends on
any of it: the desktop crate is a workspace member but not a *default* member,
and its toolchain lives in a second devShell.

## Running it

Everything runs inside the desktop shell, which the default one does not
provide:

```sh
nix develop .#desktop -c pnpm desktop:dev     # vite dev + the window, hot reload
nix develop .#desktop -c pnpm desktop:build   # pnpm build + a release binary
nix develop .#desktop -c pnpm desktop:check   # clippy -D warnings + the crate's test
```

`pnpm desktop:dev` `cd`s into `crates/sapling-desktop` (the Tauri CLI finds a
project by the `tauri.conf.json` beside its `Cargo.toml`, and there is no
`src-tauri/` here) and Tauri's `beforeDevCommand` runs `pnpm dev` back at the
repo root via the config's `cwd: "../.."`. `desktop:build` produces
`target/release/sapling-desktop`; `bundle.active` is `false`, so there is no
`.deb`/`.AppImage` and `--no-bundle` is passed — packaging is out of scope for a
spike and would need a full icon set.

New files must be `git add`ed before nix sees them (flakes read the index, not
the working tree). This looks exactly like "the flake is broken".

## Where the data lives

Tauri's per-app data directory, named by the config's `identifier`
(`app.sapling.desktop`):

| platform | path |
|---|---|
| Linux | `~/.local/share/app.sapling.desktop/` |
| macOS | `~/Library/Application Support/app.sapling.desktop/` |
| Windows | `%APPDATA%\app.sapling.desktop\` |

Inside it: `sapling.db` (plus `-wal`/`-shm` — the file is opened in WAL mode)
and `device-id`, one UUID v4 minted on first run. The device id is a *file* and
not a row because it is half of a review's identity and has to survive
`resetData`, which empties the database including `meta`. WebKit puts its own
caches and local storage in the same directory, which is also where the API key
and prefs end up — they are `localStorage` on both hosts, never in the store.

Deleting the directory is a factory reset.

## What is native and what still goes through the webview

**Native.** Persistence, and only persistence. `crates/sapling-desktop` opens
the file, lends `sapling-core` the four runtime facts (`deviceId`, the system
clock, `localDay` from the system time zone, UUID v4 ids) and exposes exactly
the three commands `WasmCore` exposes to the database Worker — `dispatch`,
`commit_all`, `derived_schema_version`. `src/lib/db/tauri.ts` is one `invoke`
per `Backend` call, chosen by `backend.ts` when `__TAURI_INTERNALS__` is on the
window; every argument still goes through `toPlain()`, because `client.ts` owns
the proxy for both transports.

**Everything else is the same web app in a webview**: the UI, the LLM call to
OpenRouter, TTS, ASR, the reading and conversation layers, the romanizer. There
is no native menu, no tray, no auto-update, no file dialog and no deep-link
handling. The window is one `main` window loading `/`.

**No CSP.** `app.security.csp` is `null`, matching the web deploy, which sets
none either and for a load-bearing reason (`deploy.md`: the YouTube iframe API
and the `youtube-nocookie` frame). Tauri's default is to inject one; turning it
off is a deliberate spike shortcut, and a shipped build should set a policy that
names those two origins rather than inherit this.

**SPA routing.** In a packaged build the app is served from `tauri://localhost`
over the custom protocol, which does *not* fall back to `index.html` the way
`static/_redirects` does. Starting at `/` works and client-side navigation
works; a reload on a deep route would not. Untested, because nothing reloads.

## What actually happens in WebKitGTK

Measured 2026-09-05 on NixOS, GNOME/Wayland, webkitgtk 2.52.6 (abi 4.1), Tauri
2.11.5, from a page loaded on the real `tauri://localhost` origin.

| feature | observed |
|---|---|
| `navigator.storage.getDirectory` (OPFS) | **`undefined`** |
| `SpeechRecognition` / `webkitSpeechRecognition` | **`undefined`** |
| `SharedArrayBuffer`, `crossOriginIsolated` | `undefined`, `false` |
| `WebAssembly` + `instantiateStreaming` | present |
| `Worker`, `AudioContext`, `AudioWorklet` | present |
| `speechSynthesis` | present (object) |
| `navigator.mediaDevices.getUserMedia` | present |
| `localStorage`, `crypto.randomUUID`, `serviceWorker` | present |
| `fetch https://openrouter.ai/api/v1/models` | `200`, response type `cors` |
| `fetch` POST to OpenRouter with no key | `401`, response type `cors` |
| `fetch https://huggingface.co/...` (TTS mirror host) | `200`, response type `cors` |
| `https://www.youtube.com/iframe_api` as a `<script>` | loads, `window.YT` is an object |
| `<iframe src="https://www.youtube-nocookie.com/embed/…">` | `onload` fires |

Item by item, against the things the brief asked about:

- **OPFS is absent, and that is the finding that justifies the whole exercise.**
  The browser persistence path — sqlite-wasm on the OPFS SAH-pool VFS inside
  `sqlite.worker.ts` — cannot run in this webview at all. The native core is not
  a performance choice here; it is the only way the app has a database. The
  Worker is never even loaded: on a real boot the webview fetched
  `src/lib/db/tauri.ts` and never `sqlite.worker.ts`.

- **Speech recognition is gone.** WebKitGTK exposes neither constructor, so
  dictation has no input method. `content.md` already says ASR is an input
  method and not a grader and that the fallback is typing, so the app degrades
  the way it was designed to — but on this host the fallback is the only path.
  `getUserMedia` *is* present, so a future recorder-plus-server transcription
  route is not blocked by the webview.

- **Cross-origin `fetch` from `tauri://localhost` works.** OpenRouter answered
  `200`/`401` with `type: "cors"`, so the API key path is fine as-is with no
  Rust-side HTTP proxy and no `tauri-plugin-http`. Same for the TTS model
  mirror's host. This was the risk that looked biggest going in and it is a
  non-issue.

- **The YouTube player loads.** Both halves of `media.md`'s YouTube path — the
  `iframe_api` script and the `youtube-nocookie` frame — load from the custom
  protocol origin. Playback itself was not driven (no interaction possible in
  this session), so "the API is reachable" is what was proven, not "a video
  plays".

- **The sherpa TTS wasm was not exercised**, because it means downloading ~439
  MB of Kokoro fp32 artifacts. Every prerequisite is there: `WebAssembly` with
  streaming instantiation, `Worker`, `AudioContext`, `AudioWorklet`, and a
  working cross-origin `fetch` to the mirror's host. `SharedArrayBuffer` is
  absent, so a threaded build would not run; the vendored sherpa glue is
  single-threaded, so that is expected to be fine and is untested.

- **Audio needs GStreamer, and without it WebKit does not degrade — it
  crashes.** This is the one that cost real time. In a shell without the
  GStreamer plugins the app starts and renders fine, logs `GStreamer element
  appsink not found`, and then the *first* `new AudioContext()` kills the whole
  WebKit web process: the page vanishes, with only `GStreamer-CRITICAL`
  assertions on stderr and nothing in the app to catch. WebKitGTK routes Web
  Audio through GStreamer, so this is every spoken word in the app, not just
  `<video>`. `flake.nix`'s `desktop` shell therefore carries
  `gstreamer` + `gst-plugins-{base,good,bad}` + `gst-libav` and exports
  `GST_PLUGIN_SYSTEM_PATH_1_0`; with them, `AudioContext` runs (its clock
  advances), `<audio>` plays a generated WAV, and the criticals are gone. A
  packaged build would have to ship or depend on these.

- **Console noise seen at launch**, none of it fatal: `VM 0x… received
  NeedDebuggerBreak trap` from JavaScriptCore's remote inspector on the first
  dev run. No compositing or dmabuf errors appeared, so
  `WEBKIT_DISABLE_DMABUF_RENDERER=1` was never needed here — reach for it first
  if a window comes up blank on another machine.

## Nix packages the shell needs

`webkitgtk_4_1` (the GTK3/abi-4.1 build `wry` asks pkg-config for — the 6.0/GTK4
one will not satisfy it), `gtk3`, `libsoup_3`, `openssl`, `pkg-config`,
`gdk-pixbuf`, `librsvg`, `cairo`, `pango`, `atk`, `glib`, `cargo-tauri`, and the
five GStreamer packages above. Two are runtime-only and therefore invisible to
the build: `glib-networking` (`GIO_MODULE_DIR`), without which every `https://`
request inside the webview fails, and GStreamer (`GST_PLUGIN_SYSTEM_PATH_1_0`),
whose absence is the crash described above.

## What a shipped version would still need

Not done, and each is real work: bundling (icons, `.deb`/`.AppImage`/`.dmg`,
signing), a CSP, an error path when the database will not open (today `setup`
returns `Err` and the app simply fails to start), SPA fallback for deep routes,
a native menu and window-state persistence, auto-update, and a decision about
whether the desktop build syncs at all — it uses the same `VITE_SYNC_URL` the
web build does, and nothing about that was exercised.
