//! Bound display metadata before it enters the native response envelope.
pub const TITLE_BYTES: usize = 4096;
pub const URL_BYTES: usize = 16384;

pub fn bounded(value: &str, limit: usize) -> String {
    let mut end = value.len().min(limit);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn truncation_preserves_utf8_and_short_values() {
        assert_eq!(bounded("short", TITLE_BYTES), "short");
        assert_eq!(bounded("a💡b", 4), "a");
        assert_eq!(bounded("a💡b", 5), "a💡");
        assert_eq!(bounded("💡", 0), "");
    }

    #[test]
    fn maximum_tab_count_and_json_escaping_fit_the_transport_budget() {
        let escaped = "\u{1}".repeat(URL_BYTES + TITLE_BYTES);
        let metadata = json!({
            "title": bounded(&escaped, TITLE_BYTES),
            "url": bounded(&escaped, URL_BYTES),
            "reservation": {"task": "💡".repeat(120), "expiresAt": u64::MAX},
        });
        let envelope = json!({"id": u64::MAX, "value": vec![metadata; 32]});
        // Leave room for the remaining fixed tab fields in every row.
        assert!(
            envelope.to_string().len() + 32 * 1024
                < remote_browser_servo::native::MAX_RESPONSE_BYTES
        );
    }
}
