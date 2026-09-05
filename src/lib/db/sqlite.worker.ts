/**
 * The database, in a dedicated module Worker.
 *
 * SQLite lives here because the OPFS SAH-pool VFS is synchronous: it blocks the
 * thread it runs on, which must therefore not be the one painting the UI. The
 * pool needs no COOP/COEP headers (that is the *other* OPFS VFS) and it refuses
 * to install while another tab holds its files — which is reported as one line
 * and no retry.
 *
 * The RPC is the domain protocol (`protocol.ts`): one message names a
 * {@link Backend} method and carries its arguments, and the Rust core —
 * `crates/sapling-core`, compiled to wasm and lent this thread's database
 * through `host.ts` — answers it. Nothing SQL-shaped crosses this boundary, so
 * the window never learns how the data is laid out.
 */
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { directOf, openCore } from './host';
import {
	dispatch,
	isBackendMethod,
	type Backend,
	type Direct,
	type WorkerInbound,
	type WorkerOutbound
} from './protocol';
import init from './wasm/sapling_core';
import wasmUrl from './wasm/sapling_core_bg.wasm?url';

function reply(message: WorkerOutbound): void {
	postMessage(message);
}

/** The device id arrives in the first message; the database opens meanwhile. */
let resolveDeviceId!: (deviceId: string) => void;
const deviceId = new Promise<string>((resolve) => {
	resolveDeviceId = resolve;
});

async function boot(): Promise<Direct<Backend>> {
	const [sqlite3] = await Promise.all([sqlite3InitModule(), init({ module_or_path: wasmUrl })]);
	const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'sapling' });
	const db = new pool.OpfsSAHPoolDb('/sapling.db');
	return directOf(openCore(db, { deviceId: await deviceId }));
}

let core: Direct<Backend> | undefined;
let bootError: string | undefined;

const booted = boot().then(
	(made) => {
		core = made;
		reply({ ready: true });
	},
	(error: unknown) => {
		bootError = String(error);
		reply({ bootError });
	}
);

self.onmessage = async (event: MessageEvent<WorkerInbound>) => {
	const message = event.data;
	if ('init' in message) {
		resolveDeviceId(message.init.deviceId);
		return;
	}
	await booted;
	if (!core) {
		reply({ id: message.id, error: bootError ?? 'no database' });
		return;
	}
	if (!isBackendMethod(message.method)) {
		reply({ id: message.id, error: `Unknown backend method ${String(message.method)}` });
		return;
	}
	try {
		reply({ id: message.id, result: dispatch(core, message) });
	} catch (error) {
		reply({ id: message.id, error: String(error) });
	}
};
