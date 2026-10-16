//! Redaction placeholders (SPEC 13.7; PLAN 6.15).

use beegit_core::ObjectId;

/// Prefix of every placeholder file.
pub const REDACTED_PLACEHOLDER_PREFIX: &str = "BeeGit: contents redacted (object ";

/// Exactly `BeeGit: contents redacted (object <id text>).\n`.
pub fn placeholder_bytes(id: &ObjectId) -> Vec<u8> {
    format!("{REDACTED_PLACEHOLDER_PREFIX}{id}).\n").into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;
    use beegit_core::Kind;

    #[test]
    fn placeholder_format() {
        let id = ObjectId::new(Kind::Blob, [0xab; 32]);
        let expected = format!(
            "BeeGit: contents redacted (object b1{}).\n",
            "ab".repeat(32)
        );
        assert_eq!(placeholder_bytes(&id), expected.into_bytes());
    }
}
