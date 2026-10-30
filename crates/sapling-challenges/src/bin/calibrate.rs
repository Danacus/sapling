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
//!
//! The ratings prototype (`ratings.rs`): `--model ratings` reports it
//! (`--words own|stability|both`, `--extra length,row,memory,ordered`;
//! `--search` its free numbers), `--compare` scores it against the others.

use std::process::ExitCode;

use sapling_challenges::calibrate::{calibrate, format_report, search_many};
use sapling_challenges::calibrate_ratings::{self, comparison};
use sapling_challenges::calibrate_v2::{ablations, format_v2, search};
use sapling_challenges::model::Observation;
use sapling_challenges::model_v2::{Config, Length, Memory, Parts, Prior};
use sapling_challenges::policy_v2::Steering;
use sapling_challenges::ratings::{Settings, WordSource};
use sapling_challenges::ratings_extras::Extras;
use sapling_challenges::replay::{busiest_profile, input_from_events, observations, parse_export};
use sapling_challenges::sim::closed_loop::{compare, Named, Scenario};
use sapling_challenges::sim::{simulate, SimOptions};

const USAGE: &str = "usage: calibrate <export.json> [--profile ID] [--search]\n       calibrate --simulated [--seed N] [--search]\n       calibrate --simulated --seeds N\n  v2:  calibrate (<export.json> | --simulated) --model v2 [--prior global|empirical|starting]\n         [--parts flat|factored] [--length learned|fixed|off] [--memory product|feature|off]\n         [--noise on|off] [--search]\n       calibrate (<export.json> | --simulated [--seeds N]) --ablate\n       calibrate --simulated --seeds N --model v2 --search\n       calibrate --simulated --policy NAME,…|steps|ratings|all --scenario base|trap|growth|new-kind|all [--seeds N]\n  ratings: calibrate (<export.json> | --simulated) --model ratings [--words own|stability|both]\n         [--extra length,row,memory,ordered] [--search]\n       calibrate (<export.json> | --simulated [--seeds N]) --compare\n       calibrate --simulated --seeds N --model ratings [--words …] --search";

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

/// The policies `--policy` names, comma-separated, `steps` (round two's
/// steps in order, each on top of the one before) or `all`.
fn policies(names: &str) -> Option<Vec<Named>> {
    let first = Config::FIRST;
    let feature = Config {
        memory: Memory::Feature,
        ..first
    };
    let joint = Config {
        joint: true,
        part_forget: 180.0,
        ..feature
    };
    let last = Config::default();
    let thompson = Steering::FIRST;
    let narrow = Steering::default();
    let decay = |scale| Steering {
        scale,
        decay: 500.0,
        ..thompson
    };
    let steps = [
        Named::Current,
        Named::V2("r1", first, thompson),
        Named::V2("+memory", feature, thompson),
        Named::V2("+joint", joint, thompson),
        Named::V2("+narrow", joint, narrow),
        Named::V2("+ordered", last, narrow),
    ];
    let more = [
        Named::V2("decay1", joint, decay(1.0)),
        Named::V2("decay.5", joint, decay(0.5)),
        Named::V2(
            "v2-start",
            Config {
                prior: Prior::Starting,
                ..last
            },
            narrow,
        ),
        Named::V2(
            "v2-fact",
            Config {
                parts: Parts::Factored,
                ..last
            },
            narrow,
        ),
        Named::V2(
            "v2-eb",
            Config {
                prior: Prior::Empirical,
                ..last
            },
            narrow,
        ),
        Named::V2(
            "v2-diag",
            Config {
                joint: false,
                ..last
            },
            narrow,
        ),
        Named::V2(
            "v2-skill",
            last,
            Steering {
                skill: true,
                ..narrow
            },
        ),
        Named::V2("v2-thompson", last, thompson),
        Named::V2(
            "forget60",
            Config {
                part_forget: 60.0,
                ..last
            },
            narrow,
        ),
        Named::V2(
            "forget365",
            Config {
                part_forget: 365.0,
                ..last
            },
            narrow,
        ),
        Named::V2(
            "static",
            Config {
                part_forget: f64::INFINITY,
                skill_forget: f64::INFINITY,
                ..last
            },
            narrow,
        ),
    ];
    let bare = Settings::default();
    let none = Extras::default();
    let with = |extras| Settings { extras, ..bare };
    let chosen = |word_start| Settings {
        word_start,
        words: WordSource::Stability,
        extras: Extras {
            length: true,
            ..none
        },
        ..bare
    };
    let ratings = [
        Named::Current,
        Named::V2("round2", last, narrow),
        Named::CurrentAt("current-harder", sapling_challenges::model::Aim::Harder),
        Named::Rated("bare", bare),
        Named::Rated(
            "bare-stab",
            Settings {
                words: WordSource::Stability,
                ..bare
            },
        ),
        Named::Rated(
            "bare-both",
            Settings {
                words: WordSource::StabilityAndOwn,
                ..bare
            },
        ),
        Named::Rated(
            "margin1",
            Settings {
                challenge_margin: 1.0,
                ..bare
            },
        ),
        Named::Rated(
            "margin.75",
            Settings {
                challenge_margin: 0.75,
                ..bare
            },
        ),
        Named::Rated(
            "widen.02",
            Settings {
                widen: 0.02,
                ..bare
            },
        ),
        Named::Rated(
            "widen.05",
            Settings {
                widen: 0.05,
                ..bare
            },
        ),
        Named::Rated(
            "margin.5",
            Settings {
                challenge_margin: 0.5,
                ..bare
            },
        ),
        Named::Rated(
            "+length",
            with(Extras {
                length: true,
                ..none
            }),
        ),
        Named::Rated("chosen", chosen(0.5)),
        Named::Rated("+row", with(Extras { row: true, ..none })),
        Named::Rated(
            "+mem",
            with(Extras {
                memory: true,
                ..none
            }),
        ),
        Named::Rated(
            "+ord",
            with(Extras {
                ordered: true,
                ..none
            }),
        ),
    ];
    if names == "steps" {
        return Some(steps.to_vec());
    }
    if names == "ratings" {
        return Some(ratings.to_vec());
    }
    let all: Vec<Named> = steps.into_iter().chain(more).chain(ratings).collect();
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
    let mut rated: Option<Settings> = None;
    let mut compare_all = false;
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
            "--compare" => compare_all = true,
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
                Some("ratings") => {
                    rated.get_or_insert_with(Settings::default);
                }
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
            "--words" => {
                let words = match rest.next().map(String::as_str) {
                    Some("own") => WordSource::Own,
                    Some("stability") => WordSource::Stability,
                    Some("both") => WordSource::StabilityAndOwn,
                    _ => return fail(),
                };
                rated.get_or_insert_with(Settings::default).words = words;
            }
            "--extra" => {
                let settings = rated.get_or_insert_with(Settings::default);
                for name in rest.next().map(String::as_str).unwrap_or("").split(',') {
                    let x = &mut settings.extras;
                    match name {
                        "length" => x.length = true,
                        "row" => x.row = true,
                        "memory" => x.memory = true,
                        "ordered" => x.ordered = true,
                        _ => return fail(),
                    }
                }
            }
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
        if ablate || compare_all {
            println!("{n} simulated learners");
            let table = if ablate {
                ablations(&logs)
            } else {
                comparison(&logs)
            };
            print!("{table}");
            return ExitCode::SUCCESS;
        }
        if let Some(settings) = rated {
            let (best, loss) = calibrate_ratings::search(&logs, settings);
            println!("best ratings over {n} simulated learners: {best:?} → {loss:.4}");
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
    if compare_all {
        print!("{}", comparison(std::slice::from_ref(&seen)));
        return ExitCode::SUCCESS;
    }
    if let Some(settings) = rated {
        if with_search {
            let (best, loss) = calibrate_ratings::search(std::slice::from_ref(&seen), settings);
            println!(
                "best ratings on this log (not used to choose anything): {best:?} → {loss:.4}"
            );
        }
        print!("{}", calibrate_ratings::report(&seen, settings));
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
