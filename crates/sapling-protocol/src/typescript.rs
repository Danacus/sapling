//! The TypeScript side of the wire, generated into `src/lib/db/generated/`
//! like the wasm build beside it: gitignored, rewritten by `pnpm core:types`,
//! which every `pnpm dev|build|check|test` runs after `core:wasm`.
//!
//! Every type is `ts-rs`'s own export, one file per type, integers as `number`.
//! Written here by hand are only what `ts-rs` cannot derive: `backend.ts` (the
//! `Backend` interface, `BACKEND_METHODS` and `EXPORT_VERSION`, from the method
//! table in `lib.rs`), `llm.ts` (the `Llm` interface, `LLM_METHODS` and the
//! prompt caps, from the table in `llm.rs`), `challenges.ts` (the synchronous
//! `Challenges` interface and `CHALLENGE_METHODS`, from `challenges.rs`),
//! `sync.ts` (the `Sync` interface, `SYNC_METHODS` and the phrase's constants,
//! from `sync.rs`),
//! `Payloads.ts` (each event type's payload) and `index.ts`, which re-exports
//! every type file.

use std::fmt::Write as _;
use std::path::{Path, PathBuf};

use ts_rs::{Config, TypeVisitor, TS};

use sapling_challenges::pool::SESSION_LENGTH;
use sapling_db::core::{ExportEnvelope, EXPORT_VERSION};
use sapling_domain::events::{
    ChallengeAdded, ChallengeReported, ChallengeServed, ConversationDeleted, EventType, ItemAdded,
    ItemDeleted, ItemReviewed, ItemUpdated, ReviewAmended, TextDeleted, WordLookedUp, WordMarked,
};
use sapling_domain::types::{
    ChallengeResult, Conversation, ConversationExchange, Profile, ReadingText,
};
use sapling_llm::lesson::REQUEST_ITEMS;
use sapling_llm::reading::{MAX_FOCUS_WORDS, MAX_TOPIC_CHARS};
use sapling_llm::{Endpoint, LlmError, ProgressStep, TokenUsage, MAX_ABOUT_CHARS};
use sapling_srs::FsrsCardState;
use sapling_sync::{BAD_PHRASE, PHRASE_LENGTH};

use crate::challenges::{challenge_methods, visit_challenge_types};
use crate::llm::{llm_methods, visit_llm_types};
use crate::sync::{sync_methods, visit_sync_types};
use crate::{methods, visit_method_types, INTERFACE_DOCS};

/// One `Backend` method, as the table declares it.
pub(crate) struct Method {
    pub name: &'static str,
    pub docs: &'static [&'static str],
    /// `(name, optional, TypeScript type)`, in order.
    pub params: Vec<(&'static str, bool, String)>,
    pub returns: String,
}

/// Exports every named type a method signature reaches, with its dependencies.
struct Export<'a>(&'a Config);

impl TypeVisitor for Export<'_> {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if T::output_path().is_some() {
            T::export_all(self.0).expect("export");
        } else {
            T::visit_generics(self);
        }
    }
}

/// Exports a payload type and names it for `Payloads.ts`.
fn payload<T: TS + 'static>(cfg: &Config) -> (String, PathBuf) {
    T::export_all(cfg).expect("export");
    (T::ident(cfg), T::output_path().expect("a declared type"))
}

/// `Payloads.ts`. The `match` is exhaustive, so a new event type does not
/// compile until it names its payload here.
fn payloads(cfg: &Config) -> String {
    let mut imports = String::new();
    let mut map = String::new();
    for kind in EventType::ALL {
        let (name, path) = match kind {
            EventType::ItemAdded => payload::<ItemAdded>(cfg),
            EventType::ItemReviewed => payload::<ItemReviewed>(cfg),
            EventType::ReviewAmended => payload::<ReviewAmended>(cfg),
            EventType::ItemUpdated => payload::<ItemUpdated>(cfg),
            EventType::ItemDeleted => payload::<ItemDeleted>(cfg),
            EventType::ChallengeAdded => payload::<ChallengeAdded>(cfg),
            EventType::ChallengeServed => payload::<ChallengeServed>(cfg),
            EventType::ChallengeReported => payload::<ChallengeReported>(cfg),
            EventType::ResultLogged => payload::<ChallengeResult>(cfg),
            EventType::ProfileUpdated => payload::<Profile>(cfg),
            EventType::TextAdded => payload::<ReadingText>(cfg),
            EventType::TextDeleted => payload::<TextDeleted>(cfg),
            EventType::WordMarked => payload::<WordMarked>(cfg),
            EventType::WordLookedUp => payload::<WordLookedUp>(cfg),
            EventType::ConversationStarted => payload::<Conversation>(cfg),
            EventType::TurnAdded => payload::<ConversationExchange>(cfg),
            EventType::ConversationDeleted => payload::<ConversationDeleted>(cfg),
        };
        let module = path.with_extension("");
        let _ = writeln!(
            imports,
            "import type {{ {name} }} from './{}';",
            module.display()
        );
        let _ = writeln!(map, "  {}: {name};", kind.as_str());
    }
    format!("{imports}\nexport type Payloads = {{\n{map}}};\n")
}

/// One interface member per method; `asynchronous` wraps the answer in a `Promise`.
fn members(out: &mut String, methods: &[Method], asynchronous: bool) {
    for method in methods {
        out.push_str("  /**\n");
        for line in method.docs {
            let _ = writeln!(out, "   *{line}");
        }
        let params: Vec<String> = method
            .params
            .iter()
            .map(|(name, optional, ty)| format!("{name}{}: {ty}", if *optional { "?" } else { "" }))
            .collect();
        let returns = if asynchronous {
            format!("Promise<{}>", method.returns)
        } else {
            method.returns.clone()
        };
        let _ = writeln!(
            out,
            "   */\n  {}({}): {returns};",
            method.name,
            params.join(", ")
        );
    }
}

/// `llm.ts`: the model calls' table as a TypeScript interface.
fn llm(names: &[String]) -> String {
    let cfg = Config::new().with_large_int("number");
    let methods = llm_methods(&cfg);
    let mut out = format!(
        "import type {{ {} }} from './index';\n\n/** The model calls, run on the window thread over `fetch`. */\nexport interface Llm {{\n",
        names.join(", ")
    );
    members(&mut out, &methods, true);
    out.push_str("}\n\nexport const LLM_METHODS = [\n");
    for method in &methods {
        let _ = writeln!(out, "  '{}',", method.name);
    }
    let _ = writeln!(
        out,
        "] as const;\n\nexport const MAX_FOCUS_WORDS = {MAX_FOCUS_WORDS};\nexport const MAX_TOPIC_CHARS = {MAX_TOPIC_CHARS};\nexport const MAX_ABOUT_CHARS = {MAX_ABOUT_CHARS};\nexport const REQUEST_ITEMS = {REQUEST_ITEMS};"
    );
    out
}

/// `challenges.ts`: the challenge decisions' table as a synchronous interface.
fn challenges(names: &[String]) -> String {
    let cfg = Config::new().with_large_int("number");
    let methods = challenge_methods(&cfg);
    let mut out = format!(
        "import type {{ {} }} from './index';\n\n/** The challenge decisions, run on the window thread. */\nexport interface Challenges {{\n",
        names.join(", ")
    );
    members(&mut out, &methods, false);
    out.push_str("}\n\nexport const CHALLENGE_METHODS = [\n");
    for method in &methods {
        let _ = writeln!(out, "  '{}',", method.name);
    }
    let _ = writeln!(
        out,
        "] as const;\n\nexport const SESSION_LENGTH = {SESSION_LENGTH};"
    );
    out
}

/// `sync.ts`: the sync client's table as a TypeScript interface.
fn sync(names: &[String]) -> String {
    let cfg = Config::new().with_large_int("number");
    let methods = sync_methods(&cfg);
    let mut out = format!(
        "import type {{ {} }} from './index';\n\n/** The sync client, run on the window thread over `fetch` and the `Backend`. */\nexport interface Sync {{\n",
        names.join(", ")
    );
    members(&mut out, &methods, true);
    out.push_str("}\n\nexport const SYNC_METHODS = [\n");
    for method in &methods {
        let _ = writeln!(out, "  '{}',", method.name);
    }
    let _ = writeln!(
        out,
        "] as const;\n\nexport const PHRASE_LENGTH = {PHRASE_LENGTH};\nexport const BAD_PHRASE = {};",
        serde_json::to_string(BAD_PHRASE).expect("a string")
    );
    out
}

/// `backend.ts`: the method table as a TypeScript interface.
fn backend(names: &[String]) -> String {
    let cfg = Config::new().with_large_int("number");
    let mut out = String::from("import type { ChallengeRow } from '../database';\n");
    let _ = writeln!(
        out,
        "import type {{ {} }} from './index';\n",
        names.join(", ")
    );
    out.push_str("/**\n");
    for line in INTERFACE_DOCS {
        let _ = writeln!(out, " *{line}");
    }
    out.push_str(" */\nexport interface Backend {\n");
    let methods = methods(&cfg);
    members(&mut out, &methods, true);
    out.push_str("}\n\nexport const BACKEND_METHODS = [\n");
    for method in &methods {
        let _ = writeln!(out, "  '{}',", method.name);
    }
    let _ = writeln!(
        out,
        "] as const;\n\nexport const EXPORT_VERSION = {};",
        EXPORT_VERSION as i64
    );
    out
}

/// Writes `src/lib/db/generated/` from scratch. `pnpm core:types` runs this.
#[test]
fn typescript() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/lib/db/generated");
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("mkdir");
    let cfg = Config::new().with_large_int("number").with_out_dir(&dir);

    visit_method_types(&mut Export(&cfg));
    EventType::export_all(&cfg).expect("export");
    ExportEnvelope::export_all(&cfg).expect("export");
    FsrsCardState::export_all(&cfg).expect("export");
    visit_llm_types(&mut Export(&cfg));
    Endpoint::export_all(&cfg).expect("export");
    LlmError::export_all(&cfg).expect("export");
    TokenUsage::export_all(&cfg).expect("export");
    ProgressStep::export_all(&cfg).expect("export");
    visit_challenge_types(&mut Export(&cfg));
    visit_sync_types(&mut Export(&cfg));
    std::fs::write(dir.join("Payloads.ts"), payloads(&cfg)).expect("write");

    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("read dir")
        .map(|entry| entry.expect("entry").path())
        .filter_map(|path| Some(path.file_stem()?.to_str()?.to_owned()))
        .collect();
    names.sort();
    let index: String = names
        .iter()
        .map(|name| format!("export type * from './{name}';\n"))
        .collect();
    std::fs::write(dir.join("index.ts"), index).expect("write");
    std::fs::write(dir.join("backend.ts"), backend(&names)).expect("write");
    std::fs::write(dir.join("llm.ts"), llm(&names)).expect("write");
    std::fs::write(dir.join("challenges.ts"), challenges(&names)).expect("write");
    std::fs::write(dir.join("sync.ts"), sync(&names)).expect("write");
}
