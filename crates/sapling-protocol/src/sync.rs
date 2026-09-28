//! The sync client by name, like the `llm!` table: async, one argument object
//! each, over the host's [`Transport`] and, for the calls that touch the log,
//! its [`SyncStore`]. Every answer is an outcome value — a cycle never fails —
//! so an `Err` here is only a malformed call. The table also generates the
//! TypeScript `Sync` interface and `SYNC_METHODS` (`sync.ts`).

use serde::Deserialize;
use serde_json::Value;
use ts_rs::TS;

use sapling_sync::{PairOutcome, SyncOutcome, SyncProbeResult, SyncStore, Transport};

use crate::required;

/// Where the relay is and who is asking. The phrase may be in any form a
/// learner typed; the client normalises it.
#[derive(Debug, Deserialize, TS)]
pub struct SyncArgs {
    pub url: String,
    pub phrase: String,
}

fn needs<S>(store: Option<&S>) -> Result<&S, String> {
    store.ok_or_else(|| "this call needs a sync store".to_owned())
}

macro_rules! sync {
    (
        |$transport:ident, $store:ident| {
            $(
                $(#[doc = $doc:literal])*
                $method:ident($arg:ident: $ty:ty) -> $ret:ty $body:block
            )*
        }
    ) => {
        /// Runs one sync call by name.
        #[allow(non_snake_case)]
        pub async fn dispatch_sync<T: Transport, S: SyncStore>(
            $transport: &T,
            $store: Option<&S>,
            method: &str,
            args: &[Value],
        ) -> Result<Value, String> {
            match method {
                $(
                    stringify!($method) => {
                        let $arg: $ty = required(method, args, 0).map_err(|e| e.0)?;
                        let value: $ret = $body.await;
                        serde_json::to_value(value).map_err(|e| e.to_string())
                    }
                )*
                _ => Err(format!("Unknown sync method {method}")),
            }
        }

        #[cfg(test)]
        pub(crate) fn sync_methods(cfg: &ts_rs::Config) -> Vec<crate::typescript::Method> {
            vec![$(
                crate::typescript::Method {
                    name: stringify!($method),
                    docs: &[$($doc),*],
                    params: vec![(stringify!($arg), false, <$ty as ts_rs::TS>::name(cfg))],
                    returns: <$ret as ts_rs::TS>::name(cfg),
                },
            )*]
        }

        #[cfg(test)]
        pub(crate) fn visit_sync_types(visitor: &mut impl ts_rs::TypeVisitor) {
            $(
                visitor.visit::<$ty>();
                visitor.visit::<$ret>();
            )*
        }
    };
}

sync! {
    |transport, store| {
        /// One whole cycle: push, stamp, pull, apply, advance the cursor.
        runSync(args: SyncArgs) -> SyncOutcome {
            sapling_sync::run(transport, needs(store)?, &args.url, &args.phrase)
        }
        /// One cycle, then whether a profile came down the log. Never writes one.
        pairDevice(args: SyncArgs) -> PairOutcome {
            sapling_sync::pair(transport, needs(store)?, &args.url, &args.phrase)
        }
        /// An empty pull: whether this device could connect, and if not, why.
        probeSync(args: SyncArgs) -> SyncProbeResult {
            sapling_sync::probe(transport, &args.url, &args.phrase)
        }
    }
}

/// [`dispatch_sync`] over the wire: the outcome as JSON, or plain text for a
/// malformed call.
pub async fn dispatch_sync_json<T: Transport, S: SyncStore>(
    transport: &T,
    store: Option<&S>,
    method: &str,
    args_json: &str,
) -> Result<String, String> {
    let args: Vec<Value> = serde_json::from_str(args_json)
        .map_err(|e| format!("{method}: arguments are not a JSON array: {e}"))?;
    dispatch_sync(transport, store, method, &args)
        .await
        .map(|answer| answer.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sapling_domain::events::RawEvent;
    use sapling_sync::relay::MemoryRelay;
    use sapling_sync::{Request, Response, StoreResult};
    use std::future::{ready, Future};

    /// A store with nothing in it and nowhere to put anything.
    struct Empty;

    impl SyncStore for Empty {
        fn pending_events(&self, _: usize) -> impl Future<Output = StoreResult<Vec<RawEvent>>> {
            ready(Ok(Vec::new()))
        }
        fn mark_pushed(&self, _: Vec<(String, f64)>) -> impl Future<Output = StoreResult<usize>> {
            ready(Ok(0))
        }
        fn apply_remote(&self, events: Vec<Value>) -> impl Future<Output = StoreResult<usize>> {
            ready(Ok(events.len()))
        }
        fn pull_cursor(&self) -> impl Future<Output = StoreResult<f64>> {
            ready(Ok(0.0))
        }
        fn set_pull_cursor(&self, _: f64) -> impl Future<Output = StoreResult<()>> {
            ready(Ok(()))
        }
        fn has_profile(&self) -> impl Future<Output = StoreResult<bool>> {
            ready(Ok(false))
        }
    }

    struct Offline;

    impl Transport for Offline {
        fn send(&self, _: Request) -> impl Future<Output = Result<Response, String>> {
            ready(Err("offline".to_owned()))
        }
    }

    const ARGS: &str = r#"[{"url":"https://sync.example","phrase":"abcde-fghjk-mnpqr-stvwx"}]"#;

    fn call<T: Transport>(
        transport: &T,
        store: Option<&Empty>,
        method: &str,
        args: &str,
    ) -> Result<Value, String> {
        pollster::block_on(dispatch_sync_json(transport, store, method, args))
            .map(|answer| serde_json::from_str(&answer).unwrap())
    }

    #[test]
    fn a_cycle_answers_its_outcome_as_json() {
        let answer = call(&MemoryRelay::default(), Some(&Empty), "runSync", ARGS).unwrap();
        assert_eq!(
            answer,
            serde_json::json!({ "ok": true, "pushed": 0, "pulled": 0, "summary": "Already up to date." })
        );
    }

    #[test]
    fn a_failure_is_still_an_answer() {
        let answer = call(&Offline, Some(&Empty), "pairDevice", ARGS).unwrap();
        assert_eq!(answer["ok"], false);
        assert_eq!(answer["message"], "Could not reach the sync server.");

        let probe = call(&Offline, None, "probeSync", ARGS).unwrap();
        assert_eq!(probe["reason"], "unreachable");
    }

    #[test]
    fn a_malformed_call_is_plain_text() {
        let relay = MemoryRelay::default();
        assert_eq!(
            call(&relay, Some(&Empty), "nope", "[]").unwrap_err(),
            "Unknown sync method nope"
        );
        assert_eq!(
            call(&relay, None, "runSync", ARGS).unwrap_err(),
            "this call needs a sync store"
        );
        assert!(call(&relay, Some(&Empty), "runSync", "[]")
            .unwrap_err()
            .starts_with("runSync: argument 0"));
    }
}
