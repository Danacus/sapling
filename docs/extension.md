# The companion browser extension

The contract is `.claude/rules/extension.md`. This is how to build and load it.

## Build

```sh
pnpm extension:build   # extension/dist/: manifest.json, background.js, bridge.js, page.js, page.css, icon
pnpm extension:dev     # the same three builds in watch mode
```

The extension talks to `https://sapling.vanoverloop.xyz` and `http://localhost:5173` (`pnpm dev`), the `ORIGINS` list in `extension/vite.config.ts`. A changed origin needs a rebuild: it is in the manifest's `matches` and `host_permissions`.

## Load it in Firefox (140 or later)

1. `pnpm extension:build`.
2. Open `about:debugging#/runtime/this-firefox`.
3. **Load Temporary Add-on…**, and pick `extension/dist/manifest.json`.
4. Open Sapling (the deployed app or `pnpm dev`) in a tab, so the term list is cached.
5. On any other page, press the Sapling toolbar button (pin it from the extensions menu if it is hidden). Press it again to switch the underlines off.

A temporary add-on is gone after a restart. After a rebuild, press **Reload** on its row in `about:debugging`, and reload the Sapling tab so the bridge content script is injected again. If Firefox lists the Sapling origins under the add-on's *Permissions* as not granted (`about:addons` → Sapling → Permissions), grant them: without them the bridge never runs and the term list never arrives.

Collected words wait in the extension; Sapling's *Garden → Inbox* (`/words/inbox`) files them.
