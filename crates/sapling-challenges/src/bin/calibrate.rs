//! Scores the difficulty model on a log, or runs it against the simulated
//! learner: `calibrate path/to/export.json` replays the file the profile
//! page's export writes (`--profile ID` picks a language profile, the busiest
//! by default; `--search` also tries a grid of `data/model.json`'s free
//! numbers on it), and `calibrate --simulated [--scenario S] [--seeds N]`
//! practises the simulated learner with the app's own planners.

use std::process::ExitCode;

use sapling_challenges::replay::{busiest_profile, input_from_events, observations, parse_export};
use sapling_challenges::research::calibrate::report;
use sapling_challenges::research::closed_loop::{self, Scenario};

const USAGE: &str = "usage: calibrate <export.json> [--profile ID] [--search]\n       calibrate --simulated [--scenario base|trap|growth|new-kind|all] [--seeds N]";

fn main() -> ExitCode {
    let mut path: Option<String> = None;
    let mut simulated = false;
    let mut with_search = false;
    let mut profile: Option<String> = None;
    let mut seeds: u64 = 20;
    let mut scenario = String::from("all");
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut rest = args.iter();
    let fail = || {
        eprintln!("{USAGE}");
        ExitCode::FAILURE
    };
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--simulated" => simulated = true,
            "--search" => with_search = true,
            "--profile" => profile = rest.next().cloned(),
            "--scenario" => match rest.next() {
                Some(s) => scenario = s.clone(),
                None => return fail(),
            },
            "--seeds" => match rest.next().and_then(|s| s.parse().ok()) {
                Some(n) => seeds = n,
                None => return fail(),
            },
            "-h" | "--help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            other if path.is_none() && !other.starts_with("--") => path = Some(other.to_owned()),
            _ => return fail(),
        }
    }

    if simulated {
        let scenarios = match scenario.as_str() {
            "all" => Scenario::ALL.to_vec(),
            name => match Scenario::parse(name) {
                Some(s) => vec![s],
                None => return fail(),
            },
        };
        for s in scenarios {
            println!("{}", closed_loop::report(s, seeds));
        }
        return ExitCode::SUCCESS;
    }

    let Some(path) = path else {
        return fail();
    };
    let json = match std::fs::read_to_string(&path) {
        Ok(json) => json,
        Err(error) => {
            eprintln!("{path}: {error}");
            return ExitCode::FAILURE;
        }
    };
    let events = match parse_export(&json) {
        Ok(events) => events,
        Err(error) => {
            eprintln!("{path}: {error}");
            return ExitCode::FAILURE;
        }
    };
    let Some(profile) = profile.or_else(|| busiest_profile(&events)) else {
        eprintln!("the log holds no answers");
        return ExitCode::FAILURE;
    };
    let seen = observations(&input_from_events(&events, &profile));
    if seen.is_empty() {
        eprintln!("profile {profile}: no answers the model can replay");
        return ExitCode::FAILURE;
    }
    println!("profile: {profile}");
    print!("{}", report(&seen, with_search));
    ExitCode::SUCCESS
}
