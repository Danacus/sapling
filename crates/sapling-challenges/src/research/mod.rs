//! The calibration command's models, policies and simulations: the model the
//! app served with before ratings (`v1.rs`), a Bayesian one (`model_v2.rs`,
//! `policy_v2.rs`), the ratings prototype with its optional extras
//! (`ratings.rs`, `ratings_extras.rs`, `ratings_policy.rs`), their reports
//! and the simulated learners they are scored on. Nothing in the app calls
//! any of it.

pub mod calibrate;
pub mod calibrate_ratings;
pub mod calibrate_v2;
pub mod model_v2;
pub mod policy_v2;
pub mod ratings;
pub mod ratings_extras;
pub mod ratings_policy;
pub mod sim;
pub mod v1;
