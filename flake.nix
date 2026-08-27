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
          ];
        };
      });
}
