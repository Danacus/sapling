/**
 * The window's {@link Backend}, over whatever carries a call to the core.
 *
 * The protocol is domain-level and the transport is the only thing that varies
 * by host, so it is one function here: {@link Transport} takes a method name
 * and its arguments and answers. In the browser that is one `postMessage` to
 * the database Worker; in the Tauri shell it is one `invoke` to the native core
 * (`./tauri`). Both build their `Backend` with {@link backendOver}, so there is
 * one place where arguments are made plain and one shape of proxy.
 *
 * Arguments pass through `toPlain` on the way out. Svelte `$state` values are
 * `Proxy` objects and structured clone throws `DataCloneError` on one, so the
 * transport is where they are stripped: no caller and no backend method has to
 * remember to.
 *
 * Browser-only — `backend.ts` reaches this module through a dynamic import so
 * node never loads the Worker at all. The desktop shell imports `backendOver`
 * from here too; the Worker is constructed in `openWorkerBackend` and nowhere
 * else, so importing this module does not start one.
 */
import SqliteWorker from './sqlite.worker?worker';
import { BUSY_MESSAGE, isSahPoolBusy } from './backend';
import { toPlain } from './plain';
import {
	BACKEND_METHODS,
	type Backend,
	type BackendMethod,
	type WorkerInbound,
	type WorkerOutbound
} from './protocol';

/** One `Backend` call, carried to wherever the core runs. */
export type Transport = (method: BackendMethod, args: unknown[]) => Promise<unknown>;

/**
 * A {@link Backend} whose every method is one {@link Transport} call.
 *
 * Each argument is made plain on its own, so a trailing `undefined` stays
 * `undefined` (a default parameter still applies) rather than becoming `null`.
 */
export function backendOver(transport: Transport): Backend {
	const backend: Partial<Record<BackendMethod, unknown>> = {};
	for (const method of BACKEND_METHODS) {
		backend[method] = (...args: unknown[]) =>
			transport(
				method,
				args.map((arg) => toPlain(arg))
			);
	}
	return backend as Backend;
}

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
				// The SAH pool refusing to install while another tab holds its files
				// is the only boot failure a learner can act on (close the other
				// tab), so it gets its own wording; anything else — a wasm
				// fetch/instantiate failure after a deploy, a missing OPFS API — is
				// worded with the Worker's own reason instead of being folded into
				// "another tab", which would send the learner to fix the wrong thing.
				reject(
					new Error(
						isSahPoolBusy(message.bootError)
							? BUSY_MESSAGE
							: `The database could not be opened: ${message.bootError}`
					)
				);
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

	const call: Transport = (method, args) => {
		const id = nextId++;
		return new Promise<unknown>((resolve, reject) => {
			waiting.set(id, { resolve, reject });
			post({ id, method, args } as WorkerInbound);
		});
	};

	post({ init: { deviceId } });
	await opened;

	return backendOver(call);
}
