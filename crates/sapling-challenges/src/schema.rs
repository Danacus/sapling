//! JSON-schema helpers for plugin wire types.

use schemars::JsonSchema;
use serde_json::Value;

pub fn inline_schema<T: JsonSchema>() -> Value {
    let mut schema = schemars::generate::SchemaSettings::draft2020_12()
        .with(|settings| settings.inline_subschemas = true)
        .into_generator()
        .into_root_schema_for::<T>()
        .to_value();
    if let Some(root) = schema.as_object_mut() {
        root.remove("$schema");
        root.remove("title");
    }
    schema
}

pub fn seal(node: &mut Value) {
    match node {
        Value::Array(items) => items.iter_mut().for_each(seal),
        Value::Object(map) => {
            map.remove("format");
            if let Some(Value::Object(properties)) = map.get("properties") {
                let keys = properties.keys().cloned().map(Value::String).collect();
                map.insert("required".into(), Value::Array(keys));
                map.insert("additionalProperties".into(), Value::Bool(false));
            }
            map.values_mut().for_each(seal);
        }
        _ => {}
    }
}
