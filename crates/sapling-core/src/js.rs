//! What JavaScript would compute and print.
//!
//! The TypeScript core stores JSON it made with `JSON.stringify` and rounds
//! with `Math.round`, so a byte-identical row and a bit-identical card need the
//! same rules here: `Number::toString` prints `1` for the double `1.0` and
//! `1e+21` past twenty-one digits, `Math.round` rounds halves towards `+∞`.
//! serde_json does neither, so this module formats every number and every
//! JSON document the crate writes.

use serde_json::Value;

/// `Math.round`: the nearest integer, halves towards `+∞`.
///
/// Not `f64::round`, which sends `-2.5` to `-3`; and not `floor(x + 0.5)`,
/// which sends `0.49999999999999994` to `1` because the addition rounds first.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let floor = x.floor();
    if x - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// ts-fsrs's `roundTo`: `Math.round(num * 10 ** decimals) / 10 ** decimals`.
pub fn round_to(x: f64, decimals: i32) -> f64 {
    let factor = 10f64.powi(decimals);
    round(x * factor) / factor
}

/// `Number.prototype.toString()` for a double — ECMA-262 §6.1.6.1.20.
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_owned();
    }
    if x == 0.0 {
        return "0".to_owned();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_owned();
    }
    if x < 0.0 {
        return format!("-{}", number_to_string(-x));
    }

    // Rust's `{:e}` is the shortest digit string that round-trips, which is
    // exactly the `s` and `n` the spec asks for.
    let exponential = format!("{x:e}");
    let (mantissa, exponent) = exponential
        .split_once('e')
        .expect("`{:e}` always carries an exponent");
    let exponent: i32 = exponent.parse().expect("`{:e}` writes a decimal exponent");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent + 1;

    if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        let split = n as usize;
        format!("{}.{}", &digits[..split], &digits[split..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let sign = if e >= 0 { '+' } else { '-' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    }
}

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_compact(value, &mut out);
    out
}

/// `JSON.stringify(value, null, indent)`.
pub fn stringify_pretty(value: &Value, indent: usize) -> String {
    let mut out = String::new();
    write_pretty(value, &" ".repeat(indent), 0, &mut out);
    out
}

fn write_number(n: &serde_json::Number, out: &mut String) {
    match n.as_f64() {
        Some(f) if f.is_finite() => out.push_str(&number_to_string(f)),
        _ => out.push_str("null"),
    }
}

/// JSON.stringify's string quoting: the short escapes it knows, `\u00xx` for
/// the other control characters, everything else verbatim.
fn write_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn write_compact(value: &Value, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => write_number(n, out),
        Value::String(s) => write_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_compact(item, out);
            }
            out.push(']');
        }
        Value::Object(entries) => {
            out.push('{');
            for (i, (key, item)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(key, out);
                out.push(':');
                write_compact(item, out);
            }
            out.push('}');
        }
    }
}

fn write_pretty(value: &Value, unit: &str, depth: usize, out: &mut String) {
    match value {
        Value::Array(items) if !items.is_empty() => {
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                out.push_str(&unit.repeat(depth + 1));
                write_pretty(item, unit, depth + 1, out);
            }
            out.push('\n');
            out.push_str(&unit.repeat(depth));
            out.push(']');
        }
        Value::Object(entries) if !entries.is_empty() => {
            out.push_str("{\n");
            for (i, (key, item)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                out.push_str(&unit.repeat(depth + 1));
                write_string(key, out);
                out.push_str(": ");
                write_pretty(item, unit, depth + 1, out);
            }
            out.push('\n');
            out.push_str(&unit.repeat(depth));
            out.push('}');
        }
        other => write_compact(other, out),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn rounds_like_math_round() {
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(round(1.5), 2.0);
        assert_eq!(round(-0.4), 0.0);
    }

    #[test]
    fn round_to_rounds_at_the_requested_decimal() {
        assert_eq!(round_to(2.118103974, 8), 2.11810397);
        assert_eq!(round_to(2.118103975, 8), 2.11810398);
        assert_eq!(round_to(1.0 / 3.0, 8), 0.33333333);
        assert_eq!(round_to(5.0, 8), 5.0);
    }

    #[test]
    fn prints_numbers_as_javascript_does() {
        assert_eq!(number_to_string(1710061260000.0), "1710061260000");
        assert_eq!(number_to_string(1.0), "1");
        assert_eq!(number_to_string(0.0), "0");
        assert_eq!(number_to_string(-0.0), "0");
        assert_eq!(number_to_string(0.1), "0.1");
        assert_eq!(number_to_string(4.75285849), "4.75285849");
        assert_eq!(number_to_string(-2.3065), "-2.3065");
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(
            number_to_string(123456789012345680000.0),
            "123456789012345680000"
        );
        assert_eq!(number_to_string(1e-7), "1e-7");
        assert_eq!(number_to_string(0.000001), "0.000001");
        assert_eq!(number_to_string(1.5e-7), "1.5e-7");
        assert_eq!(number_to_string(f64::NAN), "NaN");
    }

    #[test]
    fn stringifies_like_json_stringify() {
        let value = json!({
            "due": 1710062250000.0,
            "stability": 2.3065,
            "last_review": null,
            "ok": true,
            "tags": [],
            "nested": { "s": "a\"b\\c\n\u{1}" }
        });
        assert_eq!(
            stringify(&value),
            "{\"due\":1710062250000,\"stability\":2.3065,\"last_review\":null,\"ok\":true,\"tags\":[],\"nested\":{\"s\":\"a\\\"b\\\\c\\n\\u0001\"}}"
        );
    }

    #[test]
    fn pretty_prints_like_json_stringify_with_indent() {
        let value = json!({ "version": 3, "events": [ { "id": "a" } ], "empty": {}, "none": [] });
        assert_eq!(
            stringify_pretty(&value, 2),
            "{\n  \"version\": 3,\n  \"events\": [\n    {\n      \"id\": \"a\"\n    }\n  ],\n  \"empty\": {},\n  \"none\": []\n}"
        );
    }
}
