/**
 * The window side of the database Worker: promises over `postMessage`.
 *
 * Browser-only — `store.ts` reaches it through a dynamic import so node never
 * loads the Worker at all.
 */
import SqliteWorker from './sqlite.worker?worker';
import type { WorkerRequest, WorkerResponse } from './sqlite.worker';
import { BUSY_MESSAGE, type DbClient } from './store';

export async function openWorkerClient(): Promise<DbClient> {
	const worker = new SqliteWorker();
	const waiting = new Map<
		number,
		{ resolve: (rows: unknown[]) => void; reject: (e: Error) => void }
	>();
	let nextId = 0;

	const opened = new Promise<void>((resolve, reject) => {
		const onBoot = (event: MessageEvent<WorkerResponse>) => {
			const message = event.data;
			if ('ready' in message) {
				worker.removeEventListener('message', onBoot);
				resolve();
			} else if ('bootError' in message) {
				worker.removeEventListener('message', onBoot);
				// The SAH pool refuses to install while another tab holds its files,
				// which is the only boot failure a learner can act on.
				reject(new Error(BUSY_MESSAGE));
			}
		};
		worker.addEventListener('message', onBoot);
		// A Worker script that will not load would otherwise leave the app on a
		// spinner forever.
		worker.addEventListener('error', () => reject(new Error('The database could not be opened.')));
	});

	worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
		const message = event.data;
		if (!('id' in message)) return;
		const pending = waiting.get(message.id);
		if (!pending) return;
		waiting.delete(message.id);
		if ('error' in message) pending.reject(new Error(message.error));
		else pending.resolve(message.rows);
	});

	// A plain `Omit` over a union collapses it to the shared keys; this one
	// distributes, so each variant keeps its own fields.
	type Unaddressed<T> = T extends { id: number } ? Omit<T, 'id'> : never;

	function send(request: Unaddressed<WorkerRequest>): Promise<unknown[]> {
		const id = nextId++;
		return new Promise<unknown[]>((resolve, reject) => {
			waiting.set(id, { resolve, reject });
			worker.postMessage({ ...request, id });
		});
	}

	await opened;

	return {
		async query<T>(sql: string, params?: (string | number | null)[]): Promise<T[]> {
			return (await send({ op: 'query', sql, params })) as T[];
		},
		async batch(ops) {
			await send({ op: 'batch', ops });
		},
		async ingest(entries) {
			await send({ op: 'ingest', entries });
		},
		async importEvents(events) {
			await send({ op: 'importEvents', events });
		}
	};
}
