{
  description = "Gamified, personalized language-learning web app (SvelteKit SPA)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        lib = pkgs.lib;

        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_22
            pkgs.pnpm
            # Language servers behind the Claude Code LSP tool. Their READMEs
            # all say `npm install -g`; here they come from the devShell like
            # everything else. `svelte-language-server` provides `svelteserver`.
            pkgs.typescript-language-server
            pkgs.svelte-language-server
            # The Rust core (`crates/sapling-core`): compiler, cargo, the two
            # linters `pnpm core:check` runs, and the language server. nixpkgs'
            # rustc ships the `wasm32-unknown-unknown` std in its sysroot, so
            # the wasm build needs no overlay and no rustup.
            pkgs.rustc
            pkgs.cargo
            pkgs.clippy
            pkgs.rustfmt
            pkgs.rust-analyzer
            # The wasm32 target links with `lld`, which nixpkgs' rustc looks
            # for on PATH rather than bundling as `rust-lld`.
            pkgs.lld
            # `pnpm core:wasm` — its version must equal the `wasm-bindgen` crate
            # pinned in `crates/sapling-wasm/Cargo.toml`; the CLI rejects a
            # `.wasm` built by any other.
            pkgs.wasm-bindgen-cli
          ];
        };

        # What the Tauri shell links, shared by the `desktop` devShell and the
        # `sapling-desktop` package below so the two cannot drift apart.
        #
        # Tauri v2 on Linux is WebKitGTK, and it is linked, not bundled: the
        # webview is the host's. `webkitgtk_4_1` is the 2.x-with-GTK3 build
        # (`javascriptcoregtk-4.1`, `webkit2gtk-4.1`) that Tauri v2's `wry`
        # asks pkg-config for; the 6.0/GTK4 one is a different API and will not
        # satisfy it.
        desktopLibs = [
          pkgs.webkitgtk_4_1
          pkgs.gtk3
          pkgs.libsoup_3
          pkgs.openssl
          # gdk-pixbuf loads the window icon; librsvg is its SVG loader.
          pkgs.gdk-pixbuf
          pkgs.librsvg
          pkgs.cairo
          pkgs.pango
          pkgs.atk
          pkgs.glib
          # Spoken clips play on the host through rodio, whose cpal backend on
          # Linux is ALSA: `alsa-sys` runs pkg-config for `alsa` at build time
          # and fails the desktop build without this. At *runtime* nothing
          # more is needed on NixOS — the ALSA default device reaches PipeWire
          # through its ALSA plugin — so unlike GStreamer and glib-networking
          # this one is a build input and shows up as a build error, not as
          # silence.
          pkgs.alsa-lib
        ];

        # The runtime-only half, which no build error will ever point at.
        # `glib-networking` is a GIO module: leave it out and every `https://`
        # request inside the webview fails. GStreamer is worse: WebKitGTK
        # routes *all* audio through it, Web Audio included, and without the
        # plugins `new AudioContext()` does not degrade — it takes the whole
        # WebKit web process down with it (measured 2026-09-05, see
        # `docs/desktop.md`). Speech no longer goes through the webview's audio
        # stack at all — it plays on the Rust host — but the reader's `<video>`
        # and YouTube still do, so these stay.
        #
        # Named `gst` and not `gstreamer`: a `let` binding shadows a `with`, so
        # `with pkgs.gst_all_1; [ gstreamer ]` would refer to this list itself
        # and nix would recurse until it overflows the stack.
        gst = [
          pkgs.gst_all_1.gstreamer
          pkgs.gst_all_1.gst-plugins-base # appsrc, appsink, the decode/convert core
          pkgs.gst_all_1.gst-plugins-good # autoaudiosink, pulse/wav
          pkgs.gst_all_1.gst-plugins-bad
          pkgs.gst_all_1.gst-libav # mp3/aac, for anything the reader plays
        ];

        # The captions capability (`crates/sapling-desktop/src/captions.rs`)
        # shells out to these two, and it finds them on PATH rather than
        # pinning them — yt-dlp ages against YouTube in weeks, so a pinned
        # copy would be a pinned breakage. They are in the shell so `pnpm
        # desktop:dev` has the feature at all and so the crate's
        # skip-if-absent tests actually run, and on the packaged binary's PATH
        # because on NixOS the package *is* how a machine gets programs.
        #
        # Deno is the JavaScript runtime yt-dlp has wanted for full YouTube
        # extraction since late 2025. Without one it warns and may drop
        # formats — captions usually still come back, which is why
        # `captions_status` reports it instead of requiring it.
        desktopTools = [
          pkgs.yt-dlp
          pkgs.deno
        ];

        # The Tauri shell, kept apart from the default one on purpose: the web
        # build must never need a GTK stack to produce a static site, and CI
        # builds the app in `default`. `crates/sapling-desktop` is not a
        # workspace *default* member either, so nothing here is on the path of
        # `pnpm core:check` / `core:test`.
        desktop = pkgs.mkShell {
          inputsFrom = [ default ];
          # No `bindgenHook` here any more. The voice used to bind sherpa-onnx
          # through `sherpa-rs-sys`, which ran bindgen at build time and needed
          # a libclang pointed at by that hook; k2-fsa's own `sherpa-onnx-sys`
          # ships pregenerated bindings, so nothing in this tree runs bindgen.
          nativeBuildInputs = [ pkgs.pkg-config ];
          buildInputs = desktopLibs ++ gst;
          packages = [ pkgs.cargo-tauri ] ++ desktopTools;
          shellHook = ''
            export GIO_MODULE_DIR=${pkgs.glib-networking}/lib/gio/modules/
            export GST_PLUGIN_SYSTEM_PATH_1_0="${lib.makeSearchPathOutput "lib" "lib/gstreamer-1.0" gst}"
            export XDG_DATA_DIRS="${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:''${XDG_DATA_DIRS:-}"
            # There is no `LD_LIBRARY_PATH` for libstdc++ here any more. The old
            # sherpa bindings linked prebuilt `.so` files built against an
            # ordinary distribution's libstdc++, and a shared library's *own*
            # dependencies are not resolved through the executable's
            # `DT_RUNPATH` — so every desktop binary died at startup with
            # `libstdc++.so.6: cannot open shared object file`. sherpa-onnx is
            # linked statically now, so libstdc++ is a direct `NEEDED` of the
            # binary and nix's own linker wrapper puts it on the RUNPATH.
          '';
        };

        # `sherpa-onnx-sys`'s build script downloads k2-fsa's prebuilt static
        # libraries for its own version at build time, which the nix sandbox
        # forbids. It honours `SHERPA_ONNX_LIB_DIR` instead, so the archive is
        # fetched here as a fixed-output derivation and handed to it unpacked.
        # The version comes from `Cargo.lock` — the crate version *is* the
        # sherpa-onnx tag (docs/desktop.md) — so a bump of the pin fails this
        # hash loudly rather than linking the old libraries under new bindings.
        sherpaVersion =
          (lib.findFirst (p: p.name == "sherpa-onnx-sys") (throw "sherpa-onnx-sys is not in Cargo.lock")
            (builtins.fromTOML (builtins.readFile ./Cargo.lock)).package).version;
        # Linux only, and the package is only offered where an archive is
        # pinned: the shell links WebKitGTK, and nothing below has been tried
        # on macOS.
        sherpaArchives = {
          x86_64-linux = {
            platform = "linux-x64";
            hash = "sha256-WLP1eIW3GIIVSDK4g4xi7AfF0Spg9z92cVLmLU6SXw4=";
          };
          aarch64-linux = {
            platform = "linux-aarch64";
            hash = "sha256-Yez0bmpbNktkMqJpMInFOoHX1kAuwCY8cFl3JcKo4xE=";
          };
        };
        sherpaLibs = pkgs.fetchzip {
          url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v${sherpaVersion}/sherpa-onnx-v${sherpaVersion}-${sherpaArchives.${system}.platform}-static-lib.tar.bz2";
          inherit (sherpaArchives.${system}) hash;
        };

        tauriConf = builtins.fromJSON (builtins.readFile ./crates/sapling-desktop/tauri.conf.json);

        # The desktop app as a nix package — the NixOS way to run it, and the
        # only Linux packaging that carries the runtime-only traps above with
        # it: `wrapGAppsHook3` reads `glib-networking`, the GStreamer plugins
        # and the gsettings schemas out of `buildInputs` and writes
        # `GIO_EXTRA_MODULES`, `GST_PLUGIN_SYSTEM_PATH_1_0` and `XDG_DATA_DIRS`
        # into the wrapper, so nobody has to remember them. The AppImage
        # (`pnpm desktop:appimage`, CI only) is the path for every other Linux
        # and is deliberately *not* built under nix — see docs/desktop.md.
        #
        # `syncUrl` and `youtubeEmbedUrl` are the two build-time variables the
        # web bundle reads (`VITE_SYNC_URL`, `VITE_YOUTUBE_EMBED_URL`). The
        # defaults are this deployment's own Worker and embed page, so `nix
        # run .` is the app as deployed; `.override` points it elsewhere, and
        # `null` for either is the supported "not configured" case.
        sapling-desktop = pkgs.callPackage
          ({ syncUrl ? "https://sapling-sync.vanoverloop.xyz"
           , youtubeEmbedUrl ? "https://sapling-embed.vanoverloop.xyz/youtube.html"
           }:
            pkgs.rustPlatform.buildRustPackage (finalAttrs: {
              pname = "sapling-desktop";
              version = tauriConf.version;

              # The flake's own source is already the git-tracked tree, so
              # `node_modules`, `target`, `build` and `.direnv` are not in it.
              src = self;

              # `cargoLock` rather than `cargoHash`: it vendors straight from
              # the lockfile, so a dependency bump does not also need a hash
              # re-blessed here. `Cargo.lock` has no git dependencies.
              cargoLock.lockFile = ./Cargo.lock;
              cargoBuildFlags = [ "-p" "sapling-desktop" ];

              # This one *does* rot: it is the hash of the whole pnpm store the
              # lockfile describes. After a `pnpm-lock.yaml` change, set it to
              # `""`, build, and copy the `got:` hash back in.
              pnpmDeps = pkgs.fetchPnpmDeps {
                inherit (finalAttrs) pname version;
                src = lib.fileset.toSource {
                  root = ./.;
                  fileset = lib.fileset.unions [ ./package.json ./pnpm-lock.yaml ./pnpm-workspace.yaml ];
                };
                fetcherVersion = 4;
                hash = "sha256-sHQdRYncc2qW+huJQ19RY5esm7vfYjYzaUXicypsOME=";
              };

              nativeBuildInputs = [
                pkgs.nodejs_22
                pkgs.pnpm
                pkgs.pnpmConfigHook
                pkgs.pkg-config
                pkgs.wrapGAppsHook3
                pkgs.copyDesktopItems
                # `pnpm build` runs `core:wasm` first, which is the same wasm32
                # build the default shell does and wants the same two tools.
                pkgs.lld
                pkgs.wasm-bindgen-cli
              ];
              buildInputs = desktopLibs ++ gst ++ [
                pkgs.glib-networking
                pkgs.gsettings-desktop-schemas
              ];

              env.SHERPA_ONNX_LIB_DIR = "${sherpaLibs}/lib";

              # The web bundle first: `tauri.conf.json`'s `frontendDist` is
              # `../../build`, which `tauri::generate_context!` embeds at
              # compile time, so it has to exist before cargo gets to the
              # desktop crate. The wasm build inside it is offline through the
              # same `.cargo/config.toml` `buildRustPackage` wrote for the
              # vendored dependencies — `sapling-wasm` is in the same lockfile.
              preBuild = ''
                ${lib.optionalString (syncUrl != null) "export VITE_SYNC_URL=${lib.escapeShellArg syncUrl}"}
                ${lib.optionalString (youtubeEmbedUrl != null) "export VITE_YOUTUBE_EMBED_URL=${lib.escapeShellArg youtubeEmbedUrl}"}
                pnpm build
              '';

              # The crate's tests are `pnpm desktop:check`'s job, in CI's
              # `desktop` job; here they would only rebuild the whole
              # dependency graph a second time in test profile.
              doCheck = false;

              desktopItems = [
                (pkgs.makeDesktopItem {
                  name = "sapling";
                  desktopName = "Sapling";
                  comment = "Gamified, personalized language learning";
                  exec = "sapling-desktop";
                  icon = "sapling";
                  categories = [ "Education" "Languages" ];
                })
              ];

              # The install hook also copies the crate's `cdylib` — 36 MB that
              # exists for Android's `TauriActivity` and that nothing on a
              # desktop loads.
              postInstall = ''
                rm -rf $out/lib
                install -Dm644 static/icons/icon-512.png $out/share/icons/hicolor/512x512/apps/sapling.png
              '';

              # The crate looks the two programs up on PATH. `--suffix`, so a
              # copy the user installed themselves still wins.
              preFixup = ''
                gappsWrapperArgs+=(--suffix PATH : ${lib.makeBinPath desktopTools})
              '';

              meta = {
                description = "Sapling, the language-learning app, as a Tauri desktop window over a native SQLite core";
                mainProgram = "sapling-desktop";
                platforms = builtins.attrNames sherpaArchives;
              };
            }))
          { };
      in
      {
        devShells = { inherit default desktop; };
        packages = lib.optionalAttrs (sherpaArchives ? ${system}) {
          inherit sapling-desktop;
          default = sapling-desktop;
        };
      });
}
