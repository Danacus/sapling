//! Replays a log through the difficulty model and prints how well its
//! predictions matched: `cargo run -p sapling-challenges --bin calibrate --
//! path/to/export.json` for the file the profile page's export writes, or
//! `--simulated` for the simulated learner. `--search` also tries a grid of
//! rates; `--profile ID` picks a language profile (the busiest by default);
//! `--seed N` reseeds the simulation, and `--seeds N` searches the grid over
//! the simulated learners seeded 1..=N at once — how the starting rates were
//! chosen.

use std::process::ExitCode;

use sapling_challenges::calibrate::{calibrate, format_report, search_many};
use sapling_challenges::replay::{busiest_profile, input_from_events, observations, parse_export};
use sapling_challenges::sim::{simulate, SimOptions};

const USAGE: &str = "usage: calibrate <export.json> [--profile ID] [--search]\n       calibrate --simulated [--seed N] [--search]\n       calibrate --simulated --seeds N";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut path: Option<String> = None;
    let mut simulated = false;
    let mut with_search = false;
    let mut profile: Option<String> = None;
    let mut options = SimOptions::default();
    let mut seeds: Option<u64> = None;
    let mut rest = args.iter();
    while let Some(arg) = rest.next() {
        match arg.as_str() {
            "--simulated" => simulated = true,
            "--search" => with_search = true,
            "--profile" => profile = rest.next().cloned(),
            "--seeds" => match rest.next().and_then(|s| s.parse().ok()) {
                Some(n) => seeds = Some(n),
                None => {
                    eprintln!("{USAGE}");
                    return ExitCode::FAILURE;
                }
            },
            "--seed" => match rest.next().and_then(|s| s.parse().ok()) {
                Some(seed) => options.seed = seed,
                None => {
                    eprintln!("{USAGE}");
                    return ExitCode::FAILURE;
                }
            },
            "-h" | "--help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            other if path.is_none() && !other.starts_with("--") => path = Some(other.to_owned()),
            _ => {
                eprintln!("{USAGE}");
                return ExitCode::FAILURE;
            }
        }
    }

    if let Some(n) = seeds.filter(|_| simulated) {
        let logs: Vec<_> = (1..=n)
            .map(|seed| {
                let json = simulate(SimOptions { seed, ..options }).export_json();
                let events = parse_export(&json).expect("a simulated export parses");
                let profile = busiest_profile(&events).expect("a simulated learner answers");
                observations(&input_from_events(&events, &profile))
            })
            .collect();
        let best = search_many(&logs);
        println!(
            "best over {n} simulated learners: word {} · shared {} · challenge {} · {:?} → {:.4}",
            best.rates.word, best.rates.shared, best.rates.challenge, best.multi, best.log_loss
        );
        return ExitCode::SUCCESS;
    }

    let json = if simulated {
        simulate(options).export_json()
    } else {
        let Some(path) = path else {
            eprintln!("{USAGE}");
            return ExitCode::FAILURE;
        };
        match std::fs::read_to_string(&path) {
            Ok(json) => json,
            Err(error) => {
                eprintln!("{path}: {error}");
                return ExitCode::FAILURE;
            }
        }
    };
    let events = match parse_export(&json) {
        Ok(events) => events,
        Err(error) => {
            eprintln!("{error}");
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
    print!("{}", format_report(&calibrate(&seen, with_search), &seen));
    ExitCode::SUCCESS
}
