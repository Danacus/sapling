/**
 * Strips Svelte 5 `$state` reactivity (and anything else structured-clone
 * can't handle) from a value before it reaches Dexie.
 *
 * Every type this app persists (`Profile`, `KnowledgeItem`, `Challenge`,
 * `ChallengeResult`, `Stats`) is plain JSON-shaped data by design — no
 * `Date`s, `Map`s, functions or class instances — so a JSON round-trip is a
 * cheap, dependency-free way to produce an equivalent plain object/array
 * graph with no Proxies anywhere in it.
 *
 * `$state(...)` wraps objects and arrays (deeply, including nested arrays
 * like `Profile.interests` or `KnowledgeItem.history`) in native `Proxy`
 * instances. Dexie persists via the structured-clone algorithm, which throws
 * `DataCloneError` on a `Proxy` — so any `$state`-derived value (or a plain
 * object that merely *contains* a `$state` array by reference, e.g. after a
 * shallow `{ ...profile }` spread) must be converted before it is written.
 *
 * Note on optional properties (`notes?`, `explanation?`, `wordBank?`, …):
 * `JSON.stringify` omits object keys whose value is `undefined` rather than
 * writing `null`, so a round-trip through this function turns
 * `{ notes: undefined }` into `{}` — the key disappears rather than staying
 * present-but-undefined. Every read site in this codebase already treats
 * "key absent" and "key present with value `undefined`" the same way (plain
 * `?.`/truthiness checks, or conditional spreads that omit the key up
 * front when constructing these objects) — nothing distinguishes the two —
 * so this is safe.
 */
export function toPlain<T>(value: T): T {
	if (value === undefined) return value;
	return JSON.parse(JSON.stringify(value)) as T;
}
