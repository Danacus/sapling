//! The `calibrate` command's half of the crate, which the app never calls:
//! scoring the difficulty model on an exported log (`calibrate.rs`), the
//! simulated learner's truth and the synthetic rows tests build pools from
//! (`sim.rs`), and the closed loop that practises that learner with the
//! app's own planners (`closed_loop.rs`). Left out of the wasm build.

pub mod calibrate;
pub mod closed_loop;
pub mod sim;
