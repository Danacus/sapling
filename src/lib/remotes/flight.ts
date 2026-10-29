/**
 * Single flight for a remote: one run at a time, and no trigger lost.
 *
 * Triggers overlap by design — a tab hidden right after a session ends, the
 * reader closing while a boot cycle is still out — so a trigger while a run is
 * going queues exactly one more behind it, and every later trigger joins that
 * queued one. The queued run starts only after the running one settles, so it
 * sees whatever the first could not (a write made meanwhile, a pull that just
 * landed). Joining the *running* one instead would drop exactly that.
 *
 * Every remote's own entry point (`runSync`, `pushTaal`) and the registry's
 * `syncRemotes` wear this, so Settings calling a remote directly and a trigger
 * calling all of them cannot stack runs either.
 */
export function singleFlight<A extends unknown[], T>(
	job: (...args: A) => Promise<T>
): (...args: A) => Promise<T> {
	let running: Promise<T> | undefined;
	let queued: Promise<T> | undefined;

	function start(args: A): Promise<T> {
		queued = undefined;
		const run = job(...args).finally(() => {
			// Guarded so a run that outlives its own slot cannot clear a newer one.
			if (running === run) running = undefined;
		});
		running = run;
		return run;
	}

	return (...args: A) => {
		if (queued) return queued;
		if (running) {
			const next = running.then(
				() => start(args),
				() => start(args)
			);
			queued = next;
			return next;
		}
		return start(args);
	};
}
