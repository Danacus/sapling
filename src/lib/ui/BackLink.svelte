<!--
  The way out of a screen, and the only one the app draws.

  The desktop shell (Tauri, WebKitGTK) has no browser chrome: there is no
  back arrow, no address bar, nothing but the page. A route that relied on
  the browser's own control stranded the learner there — so every screen but
  the root and first-run owns this link, and `src/routes/back-link.test.ts`
  fails when a new one forgets it.

  `href` is always a hardcoded parent, never `history.back()`. A deep link, a
  reload or a fresh window has no history to go back to, and the parent of a
  page is a fact about the app rather than about how the learner arrived.

  `label` is the accessible name ("Back to home", "Back to your media") — the
  control is a chevron with no visible text, so the label is what a screen
  reader has to go on and is required for that reason.
-->
<script lang="ts">
	let { href, label }: { href: string; label: string } = $props();
</script>

<a class="back" {href} aria-label={label}>
	<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">
		<path d="m14.2 5.4-6.4 6.6 6.4 6.6" />
	</svg>
</a>

<style>
	/*
	  A 2.25rem squircle with a hairline, like every other icon control in the
	  app — the session screen's quit ✕ is its twin, and the two sit in the same
	  corner of the same `.topbar`. Styles are scoped to this component, so the
	  chevron carries its own stroke rather than borrowing a route's `.ico`.
	*/
	.back {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 2.25rem;
		height: 2.25rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text-muted);
		text-decoration: none;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			color 0.15s ease;
	}

	.back:hover {
		border-color: var(--border-strong);
		background: var(--surface-alt);
		color: var(--text);
	}

	.back:focus-visible {
		outline: none;
		box-shadow: var(--ring);
	}

	/* The app's one hand for icons: 24-unit box, hairline stroke, round joins. */
	.ico {
		width: 1.2rem;
		height: 1.2rem;
		fill: none;
		stroke: currentColor;
		stroke-width: 1.6;
		stroke-linecap: round;
		stroke-linejoin: round;
	}
</style>
