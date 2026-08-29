/**
 * The coalescing transform is where a diverged device's catch-up cost is
 * decided, and it is pure, so it is tested here rather than against a backend.
 *
 * What matters is not just "fewer batches": events must keep their order and
 * none may be dropped or duplicated, because the leader treats each emitted
 * batch as a contiguous run and advances its backend head to the last event in
 * it. A transform that reordered or skipped one would corrupt the cursor
 * silently, which is the failure mode this whole area keeps producing.
 */
import type { SyncBackend } from '@livestore/common';
import { Effect, Option, Stream } from '@livestore/utils/effect';
import { describe, expect, it } from 'vitest';

import { coalescePullStream } from './coalesce-pull';

type PageInfo = { _tag: 'NoMore' } | { _tag: 'MoreKnown'; remaining: number };
type Page = SyncBackend.PullResItem<never>;

/** A pull response carrying `count` events numbered from `from`. */
const page = (from: number, count: number, pageInfo: PageInfo): Page => ({
	batch: Array.from({ length: count }, (_, i) => ({
		eventEncoded: { seqNum: from + i } as never,
		metadata: Option.none<never>()
	})),
	pageInfo
});

const run = async (pages: Page[], target: number): Promise<Page[]> =>
	Effect.runPromise(
		Stream.fromIterable(pages).pipe(
			coalescePullStream(target),
			Stream.runCollect,
			Effect.map((chunk) => Array.from(chunk) as Page[])
		)
	);

const seqNums = (batch: Page['batch']) =>
	batch.map((e) => (e.eventEncoded as { seqNum: number }).seqNum);

describe('coalescePullStream', () => {
	it('merges pages until the target, then flushes', async () => {
		const pages = [
			page(1, 100, { _tag: 'MoreKnown', remaining: 200 }),
			page(101, 100, { _tag: 'MoreKnown', remaining: 100 }),
			page(201, 100, { _tag: 'NoMore' })
		];

		const out = await run(pages, 250);

		// 100 + 100 is under target; the third crosses it *and* is NoMore.
		expect(out.map((r) => r.batch.length)).toEqual([300]);
		expect(out.at(-1)!.pageInfo).toEqual({ _tag: 'NoMore' });
	});

	it('loses and reorders nothing across a long backlog', async () => {
		// 70 pages of 100 is the shape that took an hour: one rebase per page.
		const pages = Array.from({ length: 70 }, (_, i) =>
			page(
				i * 100 + 1,
				100,
				i === 69 ? { _tag: 'NoMore' } : { _tag: 'MoreKnown', remaining: (69 - i) * 100 }
			)
		);

		const out = await run(pages, 1000);

		expect(out).toHaveLength(7); // 70 rebases become 7
		expect(out.flatMap((r) => seqNums(r.batch))).toEqual(
			Array.from({ length: 7000 }, (_, i) => i + 1)
		);
	});

	it('carries the page info of the response that triggered the flush', async () => {
		const out = await run(
			[
				page(1, 100, { _tag: 'MoreKnown', remaining: 900 }),
				page(101, 100, { _tag: 'MoreKnown', remaining: 800 })
			],
			150
		);

		// Mid-backlog flushes must not claim `NoMore`: the leader reads that as
		// "pagination finished" and releases the local-push mutex early.
		expect(out).toHaveLength(1);
		expect(out[0]!.pageInfo).toEqual({ _tag: 'MoreKnown', remaining: 800 });
	});

	it('passes an empty NoMore response straight through', async () => {
		// How the backend says "nothing at all". The leader needs it to release
		// the pull mutex, so it must not be swallowed as an empty buffer.
		const out = await run([page(1, 0, { _tag: 'NoMore' })], 1000);

		expect(out).toHaveLength(1);
		expect(out[0]!.batch).toEqual([]);
		expect(out[0]!.pageInfo).toEqual({ _tag: 'NoMore' });
	});

	it('flushes a partial batch when the stream ends without NoMore', async () => {
		const out = await run([page(1, 40, { _tag: 'MoreKnown', remaining: 10 })], 1000);

		expect(out).toHaveLength(1);
		expect(seqNums(out[0]!.batch)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
		// The source is exhausted, so there genuinely is no more.
		expect(out[0]!.pageInfo).toEqual({ _tag: 'NoMore' });
	});

	it('does not hold back a small live-pull response', async () => {
		// Under a live pull each poll ends with NoMore, so a three-event update
		// must not wait for a thousand that will never arrive.
		const out = await run([page(1, 3, { _tag: 'NoMore' }), page(4, 2, { _tag: 'NoMore' })], 1000);

		expect(out.map((r) => r.batch.length)).toEqual([3, 2]);
	});

	it('drops the buffer when the source fails, rather than emitting a partial batch', async () => {
		// The leader advances its backend head to the last event of whatever it
		// is handed, so a half-batch emitted on failure would move the cursor
		// past events that were never applied. Dropping is the safe half: the
		// retry re-pulls them from the unchanged cursor.
		const failing = Stream.fromIterable([page(1, 50, { _tag: 'MoreKnown', remaining: 50 })]).pipe(
			Stream.concat(Stream.fail('boom' as const))
		);

		const exit = await Effect.runPromise(
			failing.pipe(coalescePullStream(1000), Stream.runCollect, Effect.exit)
		);

		expect(exit._tag).toBe('Failure');
	});
});
