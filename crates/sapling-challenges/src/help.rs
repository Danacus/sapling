//! A help level is a plugin-declared string step plus generic hidden-reading
//! and listening modifiers. Stable ids are recorded in answer events.

use std::fmt;

pub const HIDDEN_SUFFIX: &str = "-hidden";
pub const LISTENING: &str = "listening";

/// A stable plugin-declared step id.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Step(&'static str);

#[allow(non_upper_case_globals)]
impl Step {
    pub const Plain: Step = Step("plain");
    pub const Pick4: Step = Step("pick-4");
    pub const Pick6: Step = Step("pick-6");
    pub const Typed: Step = Step("typed");
    pub const Answers: Step = Step("answers");
    pub const Extra2: Step = Step("extra-2");
    pub const Tiles: Step = Step("tiles");

    pub const fn new(id: &'static str) -> Step {
        Step(id)
    }
    pub const fn as_str(self) -> &'static str {
        self.0
    }

    pub fn parse(id: &str) -> Option<Step> {
        [
            Self::Plain,
            Self::Pick4,
            Self::Pick6,
            Self::Typed,
            Self::Answers,
            Self::Extra2,
            Self::Tiles,
        ]
        .into_iter()
        .find(|step| step.0 == id)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct HelpLevel {
    pub step: Step,
    pub reading_hidden: bool,
    pub listening: bool,
}

impl HelpLevel {
    pub const fn step(step: Step) -> HelpLevel {
        HelpLevel {
            step,
            reading_hidden: false,
            listening: false,
        }
    }
    pub const fn hidden(step: Step) -> HelpLevel {
        HelpLevel {
            step,
            reading_hidden: true,
            listening: false,
        }
    }
    pub const LISTENING: HelpLevel = HelpLevel {
        step: Step::Plain,
        reading_hidden: false,
        listening: true,
    };

    pub fn id(&self) -> String {
        if self.listening {
            return LISTENING.to_owned();
        }
        format!(
            "{}{}",
            self.step.as_str(),
            if self.reading_hidden {
                HIDDEN_SUFFIX
            } else {
                ""
            }
        )
    }

    pub fn parse(id: &str) -> Option<HelpLevel> {
        if id == LISTENING {
            return Some(Self::LISTENING);
        }
        match id.strip_suffix(HIDDEN_SUFFIX) {
            Some(step) => Step::parse(step).map(Self::hidden),
            None => Step::parse(id).map(Self::step),
        }
    }
}

impl fmt::Display for HelpLevel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.id())
    }
}
