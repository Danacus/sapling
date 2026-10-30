//! Replays a log through the difficulty model and prints how well its
//! predictions matched: `cargo run -p sapling-challenges --bin calibrate --
//! path/to/export.json` for the file the profile page's export writes, or
//! `--simulated` for the simulated learner. `--search` also tries a grid of
//! rates; `--profile ID` picks a language profile (the busiest by default);
//! `--seed N` reseeds the simulation, and `--seeds N` searches the grid over
//! the simulated learners seeded 1..=N at once — how the starting rates were
//! chosen.
//!
//! The research prototype beside it: `--model v2` reports `model_v2.rs`
//! instead (`--prior`, `--parts`, `--length`, `--memory`, `--noise` pick its
//! variant; `--search` its spreads and drift), `--ablate` scores every variant
//! against the first model, and `--simulated --policy P --scenario S --seeds N`
//! runs the closed loop (`sim::closed_loop`) for each policy and scenario.

use std::process::ExitCode;

use sapling_challenges::calibrate::{calibrate, format_report, search_many};
use sapling_challenges::calibrate_v2::{ablations, format_v2, search};
use sapling_challenges::model::Observation;
use sapling_challenges::model_v2::{Config, Length, Memory, Parts, Prior};
use sapling_challenges::policy_v2::Steering;
use sapling_challenges::replay::{busiest_profile, input_from_events, observations, parse_export};
use sapling_challenges::sim::closed_loop::{compare, Named, Scenario};
use sapling_challenges::sim::{simulate, SimOptions};

const USAGE: &str = "usage: calibrate <export.json> [--profile ID] [--search]\n       calibrate --simulated [--seed N] [--search]\n       calibrate --simulated --seeds N\n  v2:  calibrate (<export.json> | --simulated) --model v2 [--prior global|empirical|starting]\n         [--parts flat|factored] [--length learned|fixed|off] [--memory product|feature|off]\n         [--noise on|off] [--search]\n       calibrate (<export.json> | --simulated [--seeds N]) --ablate\n       calibrate --simulated --seeds N --model v2 --search\n       calibrate --simulated --policy current,v2,v2-eb,v2-start,v2-fact,v2-skill,v2-half,v2-window,v2-static,v2-f30,v2-f180,v2-greedy|all --scenario base|trap|growth|new-kind|all [--seeds N]";

fn log_of(json: &str, profile: Option<String>) -> Result<(String, Vec<Observation>), String> {
    let events = parse_export(json)?;
    let profile = profile
        .or_else(|| busiest_profile(&events))
        .ok_or("the log holds no answers")?;
    let seen = observations(&input_from_events(&events, &profile));
    if seen.is_empty() {
        return Err(format!(
            "profile {profile}: no answers the model can replay"
        ));
    }
    Ok((profile, seen))
}

/// The policies `--policy` names, comma-separated, or `all`.
fn policies(names: &str) -> Option<Vec<Named>> {
    let base = Config::default();
    let eb = Config {
        prior: Prior::Empirical,
        ..base
    };
    let thompson = Steering::default();
    let all = [
        Named::Current,
        Named::V2("v2", base, thompson),
        Named::V2("v2-eb", eb, thompson),
        Named::V2(
            "v2-start",
            Config {
                prior: Prior::Starting,
                ..base
            },
            thompson,
        ),
        Named::V2(
            "v2-fact",
            Config {
                parts: Parts::Factored,
                ..base
            },
            thompson,
        ),
        Named::V2(
            "v2-skill",
            base,
            Steering {
                skill: true,
                ..thompson
            },
        ),
        Named::V2(
            "v2-half",
            base,
            Steering {
                scale: 0.5,
                ..thompson
            },
        ),
        Named::V2(
            "v2-window",
            base,
            Steering {
                band: [0.72, 0.93],
                ..thompson
            },
        ),
        Named::V2(
            "v2-static",
            Config {
                skill_forget: f64::INFINITY,
                part_forget: f64::INFINITY,
                ..base
            },
            thompson,
        ),
        Named::V2(
            "v2-f30",
            Config {
                part_forget: 30.0,
                ..base
            },
            thompson,
        ),
        Named::V2(
            "v2-f180",
            Config {
                part_forget: 180.0,
                ..base
            },
            thompson,
        ),
        Named::V2(
            "v2-greedy",
            base,
            Steering {
                scale: 0.0,
                ..thompson
            },
        ),
    ];
    if names == "all" {
        return Some(all.to_vec());
    }
    names
        .split(',')
        .map(|name| all.iter().find(|p| p.name() == name).copied())
        .collect()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut path: Option<String> = None;
    let mut simulated = false;
    let mut with_search = false;
    let mut profile: Option<String> = None;
    let mut options = SimOptions::default();
    let mut seeds: Option<u64> = None;
    let mut config = Config::default();
    let mut v2_asked = false;
    let mut ablate = false;
    let mut policy: Option<String> = None;
    let mut scenario: Option<String> = None;
    let mut rest = args.iter();
    let fail = || {
        eprintln!("{USAGE}");
        ExitCode::FAILURE
    };
    while let Some(arg) = rest.next() {
        if ["--prior", "--parts", "--length", "--memory", "--noise"].contains(&arg.as_str()) {
            v2_asked = true;
        }
        match arg.as_str() {
            "--simulated" => simulated = true,
            "--search" => with_search = true,
            "--ablate" => ablate = true,
            "--profile" => profile = rest.next().cloned(),
            "--policy" => policy = rest.next().cloned(),
            "--scenario" => scenario = rest.next().cloned(),
            "--seeds" => match rest.next().and_then(|s| s.parse().ok()) {
                Some(n) => seeds = Some(n),
                None => return fail(),
            },
            "--seed" => match rest.next().and_then(|s| s.parse().ok()) {
                Some(seed) => options.seed = seed,
                None => return fail(),
            },
            "--model" => match rest.next().map(String::as_str) {
                Some("v2") => v2_asked = true,
                Some("current") => {}
                _ => return fail(),
            },
            "--prior" => {
                config.prior = match rest.next().map(String::as_str) {
                    Some("global") => Prior::Global,
                    Some("empirical") => Prior::Empirical,
                    Some("starting") => Prior::Starting,
                    _ => return fail(),
                }
            }
            "--parts" => {
                config.parts = match rest.next().map(String::as_str) {
                    Some("flat") => Parts::Flat,
                    Some("factored") => Parts::Factored,
                    _ => return fail(),
                }
            }
            "--length" => {
                config.length = match rest.next().map(String::as_str) {
                    Some("learned") => Length::Learned,
                    Some("fixed") => Length::Fixed,
                    Some("off") => Length::Off,
                    _ => return fail(),
                }
            }
            "--memory" => {
                config.memory = match rest.next().map(String::as_str) {
                    Some("product") => Memory::Product,
                    Some("feature") => Memory::Feature,
                    Some("off") => Memory::Off,
                    _ => return fail(),
                }
            }
            "--noise" => match rest.next().map(String::as_str) {
                Some("on") => {}
                Some("off") => {
                    config.skill_forget = f64::INFINITY;
                    config.part_forget = f64::INFINITY;
                }
                _ => return fail(),
            },
            "-h" | "--help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            other if path.is_none() && !other.starts_with("--") => path = Some(other.to_owned()),
            _ => return fail(),
        }
    }
    let v2 = v2_asked.then_some(config);

    if policy.is_some() || scenario.is_some() {
        if !simulated {
            return fail();
        }
        let Some(named) = policies(policy.as_deref().unwrap_or("all")) else {
            return fail();
        };
        let scenarios = match scenario.as_deref().unwrap_or("all") {
            "all" => Scenario::ALL.to_vec(),
            name => match Scenario::parse(name) {
                Some(s) => vec![s],
                None => return fail(),
            },
        };
        for s in scenarios {
            println!("{}", compare(s, &named, seeds.unwrap_or(20)));
        }
        return ExitCode::SUCCESS;
    }

    if let Some(n) = seeds.filter(|_| simulated) {
        let logs: Vec<_> = (1..=n)
            .map(|seed| {
                let json = simulate(SimOptions { seed, ..options }).export_json();
                log_of(&json, None).expect("a simulated learner answers").1
            })
            .collect();
        if ablate {
            println!("{n} simulated learners");
            print!("{}", ablations(&logs));
            return ExitCode::SUCCESS;
        }
        if let Some(config) = v2 {
            let (best, loss) = search(&logs, config);
            println!("best v2 over {n} simulated learners: {best:?} → {loss:.4}");
            return ExitCode::SUCCESS;
        }
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
            return fail();
        };
        match std::fs::read_to_string(&path) {
            Ok(json) => json,
            Err(error) => {
                eprintln!("{path}: {error}");
                return ExitCode::FAILURE;
            }
        }
    };
    let (profile, seen) = match log_of(&json, profile) {
        Ok(log) => log,
        Err(error) => {
            eprintln!("{error}");
            return ExitCode::FAILURE;
        }
    };
    println!("profile: {profile}");
    if ablate {
        print!("{}", ablations(std::slice::from_ref(&seen)));
        return ExitCode::SUCCESS;
    }
    if let Some(config) = v2 {
        if with_search {
            let (best, loss) = search(std::slice::from_ref(&seen), config);
            println!("best v2 on this log: {best:?} → {loss:.4}");
        }
        print!("{}", format_v2(&seen, config));
        return ExitCode::SUCCESS;
    }
    print!("{}", format_report(&calibrate(&seen, with_search), &seen));
    ExitCode::SUCCESS
}
