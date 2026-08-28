---
paths:
  - 'src/app.css'
  - 'src/lib/ui/**'
  - 'src/routes/**/+page.svelte'
  - 'src/routes/+layout.svelte'
---

# Layout and the responsive contract

The app is **mobile-first, not mobile-only**. The phone layout is the base case and is written without a media query; every wide-screen rule is an addition on top of it. That direction is load-bearing: it means a new component is correct on a phone by default and can only be *improved* by a breakpoint, never broken by one.

## The idea

The theme is a field journal, and a journal on a desk is a **spread**. A narrow viewport shows one page; a wide one opens to two facing pages. So width is spent on a second column, a wider gutter, or a denser grid of small things — and on nothing else. **Width never makes a line of prose longer.** A paragraph that grows past its measure is the failure this whole system exists to prevent, and it is the one thing to check first in any wide-screen change.

## The vocabulary, all of it in `src/app.css`

- **Measures.** `--measure` (34rem) is the reading column and the default cap for anything holding sentences. `--measure-wide` (46rem) is a roomier single column for content that is not paragraphs — a transcript of short bubbles. `--measure-broad` (64rem) is two facing columns. `--measure-full` (78rem) is a grid of many small cards, where density is the point.
- **Gutters.** `--gutter` and `--gap` grow at the breakpoints by themselves. A component that uses them is already responsive in its spacing and needs no query of its own — reach for a query only when the *arrangement* changes.
- **Breakpoints.** Exactly two above mobile: **48rem** ("wide" — a spread becomes possible) and **72rem** ("broad" — full desktop). Always `min-width`. Custom properties do not work in media queries, so the numbers are repeated at each call site; the comment in `app.css` is the source of truth for which numbers are legitimate. **Do not add a third.** Two breakpoints are what keeps this cheap to maintain — a fourth would have to be honoured by every route that already handles the other three.
  The small `max-width: 380/400/420/480px` queries scattered through the components are a *different concern*: narrow-phone touch-ups inside the base case, not steps in this ladder. Leave them be.
- **`.shell`.** Every route's `<main>` wears it. It owns exactly two things — how wide the page may get, and the air either side. Vertical behaviour stays in the route's own scoped block, because a chat pinned to `100dvh` and a scrolling settings page genuinely differ. A route picks its cap with **at most one** modifier — `.shell-wide`, `.shell-broad`, `.shell-full` — chosen by what the content *is*, never by how much room happens to be available. The caps are unconditional rather than gated, because a 64rem cap simply does not bind on a phone.
- **`.spread`.** One column on a phone, two facing columns at ≥48rem, `align-items: start` so a short card does not stretch to match a tall one opposite — that is what makes the halves read as facing pages instead of as a table. `.spread-full` is for the children that belong to the whole spread rather than one side of it: a page header, a search row. Cards inside a spread drop their own `max-width` (a *descendant* selector, deliberately — a spread whose sides wrap their cards in a column element would slip through a child selector and leave a 34rem card ragged in a 37rem column).
- **`.spread-flow`.** The other arrangement, and the choice between the two is about whether the pairing means anything. Use `.spread` when one side is one thing and the other side is another — the home screen puts *doing* opposite *state*. Use `.spread-flow` for a long run of independent cards where nothing belongs opposite anything in particular and the only goal is two columns ending in about the same place; it is CSS multi-column, so it flows and balances itself.
  Reach for it whenever the cards differ a lot in height. A grid lays them out in *rows*, so every short card leaves a hole under it while it waits for the tall one beside it. The tempting repair is to hand-assign `order` — don't: it has to be re-tuned every time a card's content grows, and it divorces tab order from what the eye sees. `.spread-flow` reads in source order (down one column, then the next), so whatever is last in the markup is still last on screen — which is what keeps a danger zone at the foot of the page.

## What bites

- **A scoped `.shell` silently beats the global one.** Svelte scopes styles as `.shell.svelte-hash`, which outranks `.shell` from `app.css`. A route that still declares `max-width` or a `padding` *shorthand* in its scoped block has quietly opted out of the whole system — and the shorthand is the sneaky one, because `padding: 2rem 1rem 4rem` overrides `padding-inline` without looking like it touches width at all. Routes write `padding-block` and let the global rule own the sides.
- **A two-column spread is a claim about the content**, not a way to use up space. Two columns are right when the halves are independent and mean different things — the doing on one side, the state on the other. Two columns of one continuous thing is just a harder-to-read single column.
- **Forms and transcripts are where over-widening is most tempting and most wrong.** An input stretched to 78rem and a chat bubble 78rem wide are the same mistake. Bound them even when their row is full-bleed.
- **A focused screen is allowed to decline the width.** `src/routes/learn/` is one task at a time; the bar there is "genuinely better on a laptop", not "there was room". Leaving a breakpoint unwritten is a valid outcome and needs no defence.
- The base case must stay untouched by every wide-screen change. When reviewing one, the question is not "does it look good at 1440px" but "is this rule reachable at 375px" — if it is, it belongs in the base case or nowhere.
