/**
 * The window side of the database Worker: a {@link Backend} whose every method
 * is one `postMessage` and one reply.
 *
 * Browser-only — `backend.ts` reaches it through a dynamic import so node never
 * loads the Worker at all.
 *
 * Arguments pass through `toPlain` on the way out. Svelte `$state` values are
 * `Proxy` objects and structured clone throws `DataCloneError` on one, so the
 * transport is where they are stripped: no caller and no backend method has to
 * remember to.
 */
import SqliteWorker from './sqlite.worker?worker';
import { BUSY_MESSAGE } from './backend';
import { toPlain } from './plain';
import {
	BACKEND_METHODS,
	type Backend,
	type BackendMethod,
	type WorkerInbound,
	type WorkerOutbound
} from './protocol';

export async function openWorkerBackend(deviceId: string): Promise<Backend> {
	const worker = new SqliteWorker();
	const waiting = new Map<
		number,
		{ resolve: (result: unknown) => void; reject: (e: Error) => void }
	>();
	let nextId = 0;

	const opened = new Promise<void>((resolve, reject) => {
		const onBoot = (event: MessageEvent<WorkerOutbound>) => {
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

	worker.addEventListener('message', (event: MessageEvent<WorkerOutbound>) => {
		const message = event.data;
		if (!('id' in message)) return;
		const pending = waiting.get(message.id);
		if (!pending) return;
		waiting.delete(message.id);
		if ('error' in message) pending.reject(new Error(message.error));
		else pending.resolve(message.result);
	});

	function post(message: WorkerInbound): void {
		worker.postMessage(message);
	}

	function call(method: BackendMethod, args: unknown[]): Promise<unknown> {
		const id = nextId++;
		return new Promise<unknown>((resolve, reject) => {
			waiting.set(id, { resolve, reject });
			// Each argument on its own, so a trailing `undefined` stays `undefined`
			// (a default parameter still applies) rather than becoming `null`.
			post({ id, method, args: args.map((arg) => toPlain(arg)) } as WorkerInbound);
		});
	}

	post({ init: { deviceId } });
	await opened;

	const backend: Partial<Record<BackendMethod, unknown>> = {};
	for (const method of BACKEND_METHODS) {
		backend[method] = (...args: unknown[]) => call(method, args);
	}
	return backend as Backend;
}
