//! Calendar days, for the `daily` table.
//!
//! `resultLogged` buckets answers by the learner's *local* calendar day, which
//! the TypeScript reads off the runtime's time zone. This crate has no time
//! zone of its own, so the host says what day a timestamp falls on through
//! [`LocalDay`]; [`Utc`] is the answer a fixture run and a server both want.

/// `YYYY-MM-DD` for an epoch-milliseconds timestamp, in the host's zone.
pub trait LocalDay {
    fn local_day(&self, at: f64) -> String;
}

/// The UTC calendar — what the golden fixtures are recorded under.
#[derive(Debug, Clone, Copy, Default)]
pub struct Utc;

impl LocalDay for Utc {
    fn local_day(&self, at: f64) -> String {
        // `new Date(at)` truncates towards zero before it does anything else.
        let ms = at.trunc();
        let days = (ms / 86_400_000.0).floor() as i64;
        let (year, month, day) = civil_from_days(days);
        format!("{year}-{month:02}-{day:02}")
    }
}

/// Days since 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_by_utc_day() {
        assert_eq!(Utc.local_day(0.0), "1970-01-01");
        assert_eq!(Utc.local_day(1710061260000.0), "2024-03-10");
        // 23:59:59.999 and the next millisecond are different days.
        assert_eq!(Utc.local_day(1710115199999.0), "2024-03-10");
        assert_eq!(Utc.local_day(1710115200000.0), "2024-03-11");
        assert_eq!(Utc.local_day(951782400000.0), "2000-02-29");
    }
}
