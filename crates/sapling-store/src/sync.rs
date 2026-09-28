//! `sapling-sync`'s store over the native core: what a native frontend (a CLI,
//! say) hands `sapling_sync::run` beside a transport of its own. Each call is
//! one [`CoreHandle::run`] and answers before its future is polled, which is
//! fine for a cycle that awaits each call before the next.

use std::future::{ready, Future};

use serde_json::Value;

use sapling_db::Core;
use sapling_domain::events::RawEvent;
use sapling_sync::{StoreError, StoreResult, SyncStore};

use crate::CoreHandle;

impl CoreHandle {
    fn sync_call<T: Send + 'static>(
        &self,
        call: impl FnOnce(&Core) -> sapling_db::Result<T> + Send + 'static,
    ) -> impl Future<Output = StoreResult<T>> {
        ready(match self.run(call) {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(error)) => Err(StoreError(error.0)),
            Err(error) => Err(StoreError(error)),
        })
    }
}

impl SyncStore for CoreHandle {
    fn pending_events(&self, limit: usize) -> impl Future<Output = StoreResult<Vec<RawEvent>>> {
        self.sync_call(move |core| core.pending_events(limit as i64))
    }

    fn mark_pushed(&self, seqs: Vec<(String, f64)>) -> impl Future<Output = StoreResult<usize>> {
        self.sync_call(move |core| core.mark_pushed(&seqs))
    }

    fn apply_remote(&self, events: Vec<Value>) -> impl Future<Output = StoreResult<usize>> {
        self.sync_call(move |core| core.apply_remote(&events))
    }

    fn pull_cursor(&self) -> impl Future<Output = StoreResult<f64>> {
        self.sync_call(Core::get_pull_cursor)
    }

    fn set_pull_cursor(&self, cursor: f64) -> impl Future<Output = StoreResult<()>> {
        self.sync_call(move |core| core.set_pull_cursor(cursor))
    }

    fn has_profile(&self) -> impl Future<Output = StoreResult<bool>> {
        self.sync_call(|core| core.get_profile().map(|profile| profile.is_some()))
    }
}
