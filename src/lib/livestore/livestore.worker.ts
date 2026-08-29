/**
 * SPIKE — the LiveStore leader worker.
 *
 * The web adapter runs the SQLite database on a dedicated worker (plus a
 * shared worker for cross-tab election). Vite needs this to be its own module
 * imported with `?worker`; see `src/routes/livestore-spike/+page.svelte`.
 */
import { makeWorker } from '@livestore/adapter-web/worker';

import { schema } from './schema';

makeWorker({ schema });
