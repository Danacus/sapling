---
name: add-challenge-type
description: >
  Add a new challenge plugin or a generation kind to an existing plugin.
  Use for new question/exercise types, stored challenge union members, or model wire kinds.
argument-hint: [type-or-kind]
---

# Adding a challenge type or kind

First decide which boundary changes:

- Add a **kind** when the model can emit a new prompt shape that resolves to an existing stored type and uses that type's serving and grading.
- Add a **plugin type** only when stored shape, screen, answer or grading behavior genuinely differs.

## Add a kind to an existing plugin

1. In `crates/sapling-challenges/src/types/<type>/mod.rs`, add its `Deserialize + JsonSchema` wire shape and resolver behavior. Keep cosmetic cleanup lenient, but reject answers/references that would make the stored row invalid.
2. Add the kind to that plugin's `type.json`. Preserve existing ranks; append a new explicit rank unless a migration explicitly requires otherwise. Include direction, stored discriminator facts, lengths, written steps, and listening capability; no difficulty numbers (every kind's ratings start alike). Omit lengths only for a retired kind that must remain readable but never be planned.
3. Add `lessons/<kind>.json` in the same plugin folder and register it in the plugin's `LESSONS`. It owns prompt/rules/params/corrective/escalation specs and fixtures. The generic lesson registry discovers it through the plugin registry.
4. Add resolver/schema/fixture cases and run the gates below. Never add a central source arm or global kinds-data entry; those no longer exist.

## Add a plugin type

1. Create `crates/sapling-challenges/src/types/<type>/mod.rs` with:
   - a stable serialized tag and lenient stored struct;
   - a type-specific `Screen` and learner `Answer`;
   - `ChallengePlugin` constants and every method: common fields, asked-length setter, strict fresh-row shape check, steps/readings/listening, screen, audio, grade plus stable log text, canonical answer and measurement;
   - generation wire shapes/resolvers and lesson sources when model-written. A locally built type may have zero kinds, as match pairs does.
2. Add `type.json` and any `lessons/*.json`. Keep stored JSON, help ids and event text stable. New stored fields must be optional and absent when unset.
3. Add exactly one tuple to `challenge_types!` in `types/mod.rs`, including the module, plugin marker, generated variant/shape names and tag. Re-export public leaf shapes used elsewhere. Do not add per-type matches to generic modules.
4. Create `src/lib/challenges/types/<type>/<Component>.svelte`. Type its props as `ChallengeProps<'tag'>`; render `screen`, report `AnswerOf<'tag'>`, and use `graded` for locked feedback. Put reusable controls in `challenges/blocks`.
5. Add exactly one entry to `CHALLENGE_COMPONENTS` in `src/lib/challenges/types/index.ts`. Do not branch in `ChallengeHost`, the session, feedback, escalation or generic wrappers.
6. Add type-specific behavior tests beside the plugin/component. The generic Rust conformance suite automatically exercises every registry member; extend its sample/canonical cases if the new shapes require it.

## Required gates

Run `pnpm format`, `pnpm check`, `pnpm test`, `pnpm core:check`, and `pnpm core:test`. Read any golden/calibration diff before changing fixtures: this workflow is not permission to change stored rows, event payloads, help/kind ids, seeded ordering, model values or prior verdicts.
