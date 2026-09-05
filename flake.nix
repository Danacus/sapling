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
      in
      {
        devShells.default = pkgs.mkShell {
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
      });
}
