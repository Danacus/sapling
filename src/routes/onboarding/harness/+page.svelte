<!-- TEMPORARY browser sync harness. Deleted after use. -->
<script lang="ts">
	import { onMount } from 'svelte';

	let status = $state('booting');

	onMount(async () => {
		(globalThis as { __skipMigration?: boolean }).__skipMigration =
			new URLSearchParams(location.search).get('skipMigration') === '1';
		const [{ storeReady }, { events, tables }] = await Promise.all([
			import('$lib/livestore/store'),
			import('$lib/livestore/schema')
		]);
		const store = await storeReady();

		// The layout redirects to onboarding without a profile; give it one so the
		// harness page stays put. This is a real profileUpdated event.
		const existing = store.query(tables.profile.select());
		if (existing.length === 0) {
			store.commit(
				events.profileUpdated({
					nativeLanguage: 'en',
					targetLanguage: 'zh',
					level: 'beginner',
					interests: [],
					model: 'mock',
					createdAt: Date.now()
				})
			);
		}

		Object.assign(window as unknown as Record<string, unknown>, {
			__h: {
				commit(n: number, prefix: string) {
					for (let i = 0; i < n; i++) {
						store.commit(
							events.itemAdded({
								id: `${prefix}-${i}`,
								kind: 'vocab',
								term: `${prefix}-${i}`,
								meaning: 'm',
								introducedAt: 1
							})
						);
					}
					return n;
				},
				async state() {
					const st = store as unknown as {
						syncStatus: () => { localHead: string; upstreamHead: string; pendingCount: number };
						_dev: { syncStates: () => Promise<Record<string, unknown>> };
					};
					const sum = (x: unknown) => {
						const o = x as {
							pending?: unknown[];
							localHead?: { global: number; client: number; rebaseGeneration: number };
							upstreamHead?: { global: number; client: number; rebaseGeneration: number };
						};
						const h = (v?: { global: number; client: number; rebaseGeneration: number }) =>
							v ? `${v.global}.${v.client}r${v.rebaseGeneration}` : '?';
						return {
							pending: o.pending?.length ?? -1,
							first: o.pending?.[0] ? (o.pending[0] as { name: string }).name : null,
							local: h(o.localHead),
							up: h(o.upstreamHead)
						};
					};
					let states: Record<string, unknown> = {};
					try {
						states = await st._dev.syncStates();
					} catch (e) {
						return { error: String(e) };
					}
					return {
						status: st.syncStatus(),
						session: sum(states.session),
						leader: sum(states.leader)
					};
				},
				count() {
					const rows = store.query(tables.items.select()) as { id: string }[];
					return {
						total: rows.length,
						a: rows.filter((r) => r.id.startsWith('a-')).length,
						b: rows.filter((r) => r.id.startsWith('b-')).length
					};
				}
			}
		});
		status = 'ready';
	});
</script>

<p id="status">{status}</p>
