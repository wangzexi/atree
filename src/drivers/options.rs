pub(crate) fn string(options: &serde_json::Value, key: &str) -> Option<String> {
    options
        .get(key)
        .and_then(|value| value.as_str())
        .filter(|value| !value.trim().is_empty())
        .map(ToString::to_string)
}

pub(crate) fn bool(options: &serde_json::Value, key: &str) -> bool {
    options
        .get(key)
        .and_then(|value| {
            value.as_bool().or_else(|| {
                value
                    .as_str()
                    .map(|value| matches!(value, "true" | "yes" | "1"))
            })
        })
        .unwrap_or(false)
}

pub(crate) fn u64(options: &serde_json::Value, key: &str) -> Option<u64> {
    options
        .get(key)
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
}

pub(crate) fn string_list(options: &serde_json::Value, key: &str) -> Vec<String> {
    match options.get(key) {
        Some(serde_json::Value::Array(values)) => values
            .iter()
            .filter_map(|value| value.as_str())
            .filter(|value| !value.trim().is_empty())
            .map(ToString::to_string)
            .collect(),
        Some(serde_json::Value::String(value)) if !value.trim().is_empty() => value
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    }
}
