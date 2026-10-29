//! The Taal client by name, like the `sync!` table: async, one argument object
//! each, over the host's [`Transport`] and its [`TaalStore`]. Every answer is
//! an outcome value — a refused or unreachable Taal is an answer — so an `Err`
//! here is only a malformed call. The table also generates the TypeScript
//! `Taal` interface and `TAAL_METHODS` (`taal.ts`).

use serde_json::Value;

use sapling_taal::{TaalOutcome, TaalPushArgs, TaalStore, Transport};

use crate::required;

macro_rules! taal {
    (
        |$transport:ident, $store:ident| {
            $(
                $(#[doc = $doc:literal])*
                $method:ident($arg:ident: $ty:ty) -> $ret:ty $body:block
            )*
        }
    ) => {
        /// Runs one Taal call by name.
        #[allow(non_snake_case)]
        pub async fn dispatch_taal<T: Transport, S: TaalStore>(
            $transport: &T,
            $store: &S,
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
                _ => Err(format!("Unknown taal method {method}")),
            }
        }

        #[cfg(test)]
        pub(crate) fn taal_methods(cfg: &ts_rs::Config) -> Vec<crate::typescript::Method> {
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
        pub(crate) fn visit_taal_types(visitor: &mut impl ts_rs::TypeVisitor) {
            $(
                visitor.visit::<$ty>();
                visitor.visit::<$ret>();
            )*
        }
    };
}

taal! {
    |transport, store| {
        /// The active profile's study sessions since the watermark's re-send
        /// margin, in batches of 100; the new watermark when all landed.
        pushTaal(args: TaalPushArgs) -> TaalOutcome {
            sapling_taal::push(transport, store, &args)
        }
    }
}

/// [`dispatch_taal`] over the wire: the outcome as JSON, or plain text for a
/// malformed call.
pub async fn dispatch_taal_json<T: Transport, S: TaalStore>(
    transport: &T,
    store: &S,
    method: &str,
    args_json: &str,
) -> Result<String, String> {
    let args: Vec<Value> = serde_json::from_str(args_json)
        .map_err(|e| format!("{method}: arguments are not a JSON array: {e}"))?;
    dispatch_taal(transport, store, method, &args)
        .await
        .map(|answer| answer.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sapling_domain::types::StudySession;
    use sapling_taal::{Request, Response};
    use std::future::{ready, Future};

    struct Empty;

    impl TaalStore for Empty {
        fn study_sessions(
            &self,
            _: f64,
        ) -> impl Future<Output = Result<Vec<StudySession>, String>> {
            ready(Ok(Vec::new()))
        }
    }

    struct Offline;

    impl Transport for Offline {
        fn send(&self, _: Request) -> impl Future<Output = Result<Response, String>> {
            ready(Err("offline".to_owned()))
        }
    }

    fn call(method: &str, args: &str) -> Result<Value, String> {
        pollster::block_on(dispatch_taal_json(&Offline, &Empty, method, args))
            .map(|answer| serde_json::from_str(&answer).unwrap())
    }

    #[test]
    fn a_push_answers_its_outcome_as_json() {
        let code = format!("{}.{}", "a".repeat(20), "b".repeat(32));
        let args = serde_json::json!([{ "code": code, "profile": "p", "now": 5 }]).to_string();
        assert_eq!(
            call("pushTaal", &args).unwrap(),
            serde_json::json!({
                "status": "ok", "sent": 0, "pushedThrough": 5.0, "message": "Nothing new to send."
            })
        );
        let junk = r#"[{"code":"x","profile":"p","now":5}]"#;
        assert_eq!(call("pushTaal", junk).unwrap()["status"], "invalid");
    }

    #[test]
    fn a_malformed_call_is_plain_text() {
        assert_eq!(call("nope", "[]").unwrap_err(), "Unknown taal method nope");
        assert!(call("pushTaal", "[]")
            .unwrap_err()
            .starts_with("pushTaal: argument 0"));
    }
}
