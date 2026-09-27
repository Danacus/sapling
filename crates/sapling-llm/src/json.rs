use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// The JSON object in a reply: fences dropped, else the outermost brace pair.
pub fn strip_fences(text: &str) -> &str {
    let mut out = text.trim();
    if let Some(rest) = out.strip_prefix("```") {
        if let Some(inner) = rest.strip_suffix("```") {
            let inner = inner.trim_start_matches(|c: char| c.is_ascii_alphabetic());
            out = inner.trim();
        }
    }
    if out.starts_with('{') {
        return out;
    }
    match (out.find('{'), out.rfind('}')) {
        (Some(start), Some(end)) if end > start => out[start..=end].trim(),
        _ => out,
    }
}

/// A reply's JSON as `T`, or `None` when it is not that shape.
pub fn parse_reply<T: DeserializeOwned>(raw: &str) -> Option<T> {
    serde_json::from_str(strip_fences(raw)).ok()
}

/// `T`'s JSON schema as strict structured outputs want it: every property
/// required, no additional ones. An optional key stays expressible as nullable.
pub fn strict_schema<T: JsonSchema>() -> Value {
    let mut schema = schemars::schema_for!(T).to_value();
    if let Some(root) = schema.as_object_mut() {
        root.remove("$schema");
        root.remove("title");
    }
    require_every_key(&mut schema);
    schema
}

fn require_every_key(node: &mut Value) {
    match node {
        Value::Array(items) => items.iter_mut().for_each(require_every_key),
        Value::Object(map) => {
            if let Some(Value::Object(properties)) = map.get("properties") {
                let keys: Vec<Value> = properties.keys().cloned().map(Value::String).collect();
                map.insert("required".into(), Value::Array(keys));
                map.insert("additionalProperties".into(), Value::Bool(false));
            }
            map.values_mut().for_each(require_every_key);
        }
        _ => {}
    }
}

/// Fills `{name}` placeholders in every string of a fixture.
pub fn fill(value: &mut Value, vars: &[(&str, &str)]) {
    match value {
        Value::String(text) => {
            for (name, with) in vars {
                *text = text.replace(&format!("{{{name}}}"), with);
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|item| fill(item, vars)),
        Value::Object(map) => map.values_mut().for_each(|item| fill(item, vars)),
        _ => {}
    }
}

/// As a real reply often arrives: fenced, so the mock exercises [`strip_fences`] too.
pub fn fenced(value: &Value) -> String {
    format!("```json\n{value}\n```")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;
    use serde_json::json;

    #[test]
    fn strips_fences_and_surrounding_prose() {
        assert_eq!(strip_fences("```json\n{\"a\":1}\n```"), "{\"a\":1}");
        assert_eq!(strip_fences("```\n{\"a\":1}```"), "{\"a\":1}");
        assert_eq!(
            strip_fences("Sure! {\"a\":{}} Hope that helps"),
            "{\"a\":{}}"
        );
        assert_eq!(strip_fences("  {\"a\":1} "), "{\"a\":1}");
        assert_eq!(strip_fences("nothing"), "nothing");
    }

    #[derive(Deserialize, JsonSchema)]
    #[allow(dead_code)]
    struct Inner {
        a: String,
        b: Option<String>,
    }

    #[derive(Deserialize, JsonSchema)]
    #[allow(dead_code)]
    struct Outer {
        items: Vec<Inner>,
        note: Option<String>,
    }

    #[test]
    fn a_strict_schema_requires_every_key_all_the_way_down() {
        let schema = strict_schema::<Outer>();
        assert!(schema.get("$schema").is_none());
        assert_eq!(schema["required"], json!(["items", "note"]));
        assert_eq!(schema["additionalProperties"], false);
        let inner = &schema["$defs"]["Inner"];
        assert_eq!(inner["required"], json!(["a", "b"]));
        assert_eq!(inner["additionalProperties"], false);
        assert_eq!(inner["properties"]["b"]["type"], json!(["string", "null"]));
    }

    #[test]
    fn fill_substitutes_in_every_string() {
        let mut value = json!({ "a": "x {t} y", "b": ["{t}"], "c": null });
        fill(&mut value, &[("t", "\"q\"")]);
        assert_eq!(
            value,
            json!({ "a": "x \"q\" y", "b": ["\"q\""], "c": null })
        );
    }
}
