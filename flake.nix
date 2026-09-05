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

        # The Tauri shell, kept apart from the default one on purpose: the web
        # build must never need a GTK stack to produce a static site, and CI
        # builds the app in `default`. `crates/sapling-desktop` is not a
        # workspace *default* member either, so nothing here is on the path of
        # `pnpm core:check` / `core:test`.
        #
        # Tauri v2 on Linux is WebKitGTK, and it is linked, not bundled: the
        # webview is the host's. `webkitgtk_4_1` is the 2.x-with-GTK3 build
        # (`javascriptcoregtk-4.1`, `webkit2gtk-4.1`) that Tauri v2's `wry`
        # asks pkg-config for; the 6.0/GTK4 one is a different API and will not
        # satisfy it. `glib-networking` is the one that is easy to miss — it is
        # a *runtime* GIO module, so leaving it out costs no build error and
        # every `https://` request inside the webview instead.
        #
        # GStreamer is the other runtime-only one, and it is worse: WebKitGTK
        # routes *all* audio through it, Web Audio included, and without the
        # plugins `new AudioContext()` does not degrade — it takes the whole
        # WebKit web process down with it (measured 2026-09-05, see
        # `docs/desktop.md`). The TTS player builds one on the first spoken
        # word, so these are not optional.
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

        desktop = pkgs.mkShell {
          inputsFrom = [ default ];
          nativeBuildInputs = [ pkgs.pkg-config ];
          buildInputs = [
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
          ] ++ gst;
          packages = [ pkgs.cargo-tauri ];
          shellHook = ''
            export GIO_MODULE_DIR=${pkgs.glib-networking}/lib/gio/modules/
            export GST_PLUGIN_SYSTEM_PATH_1_0="${pkgs.lib.makeSearchPathOutput "lib" "lib/gstreamer-1.0" gst}"
            export XDG_DATA_DIRS="${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:''${XDG_DATA_DIRS:-}"
          '';
        };
      in
      {
        devShells = { inherit default desktop; };
      });
}
