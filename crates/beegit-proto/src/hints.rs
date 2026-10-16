//! Actionable hints for transport failures (B-UX-3).
//!
//! Connection errors arrive as layered library messages ("transport error: invalid peer
//! certificate: UnknownIssuer"). [`hint`] recognizes the common causes and returns one
//! sentence saying what to do. Hints never contain secrets or file contents; a socket path
//! is described only by its length.

use crate::endpoint::Endpoint;

/// Unix socket paths longer than this do not fit `sockaddr_un.sun_path` (108 bytes with the
/// terminating NUL on Linux, 104 on macOS).
const MAX_SOCKET_PATH: usize = 103;

/// A hint for an error whose text (including its cause chain) is `text`, when one applies.
pub fn hint(text: &str, ep: Option<&Endpoint>) -> Option<String> {
    let has = |s: &str| text.contains(s);
    if has("SUN_LEN") {
        let len = match ep {
            Some(Endpoint::Unix(p)) => format!(" (this one is {} bytes)", p.as_os_str().len()),
            _ => String::new(),
        };
        return Some(format!(
            "Unix socket paths are limited to about {MAX_SOCKET_PATH} bytes{len}; \
             use a shorter socket path"
        ));
    }
    if has("missing grpc-status trailer") {
        return Some(
            "a proxy between you and the server dropped the gRPC trailers; behind Cloudflare \
             Tunnel use the grpc-web+https://<host> endpoint"
                .to_owned(),
        );
    }
    if has("UnknownIssuer") {
        return Some(
            "the server certificate is not signed by a CA you trust: set BEEGIT_CA_FILE or \
             --ca-file to the CA that signed it (the local stack uses dev/state/ca.pem), or \
             unset BEEGIT_CA_FILE for a public certificate"
                .to_owned(),
        );
    }
    if has("not valid for name") {
        return Some(
            "the server certificate does not cover this host name: connect with a name listed \
             in the certificate, or re-issue it with this name in BEEGIT_TLS_SANS"
                .to_owned(),
        );
    }
    if has("Connection refused") {
        return Some(
            "nothing is listening there: is the server (or daemon) running, and is the port \
             right?"
                .to_owned(),
        );
    }
    if has("dns error") || has("failed to lookup address") {
        return Some(
            "the host name does not resolve: check the endpoint spelling and your DNS".to_owned(),
        );
    }
    if has("timed out") || has("deadline has elapsed") {
        return Some(
            "the connection timed out: check that the host is reachable and the port is open \
             in any firewall"
                .to_owned(),
        );
    }
    if matches!(ep, Some(Endpoint::Unix(_))) && has("No such file or directory") {
        return Some(
            "no daemon socket at that path: start beegit-daemon or fix the endpoint".to_owned(),
        );
    }
    None
}

/// `message`, followed by `; hint: <hint>` when [`hint`] recognizes it.
pub fn with_hint(message: String, ep: Option<&Endpoint>) -> String {
    match hint(&message, ep) {
        Some(h) => format!("{message}; hint: {h}"),
        None => message,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_the_common_failures() {
        let https = Endpoint::parse("https://example.com").unwrap();
        let cases = [
            (
                "transport error: tcp connect error: Connection refused (os error 111)",
                "nothing is listening",
            ),
            (
                "transport error: dns error: failed to lookup address information",
                "does not resolve",
            ),
            (
                "transport error: invalid peer certificate: UnknownIssuer",
                "BEEGIT_CA_FILE",
            ),
            (
                "invalid peer certificate: certificate not valid for name \"1.2.3.4\"",
                "BEEGIT_TLS_SANS",
            ),
            (
                "protocol error: missing grpc-status trailer, stream was terminated",
                "grpc-web+https://",
            ),
        ];
        for (text, want) in cases {
            let h = hint(text, Some(&https)).unwrap();
            assert!(h.contains(want), "{text} -> {h}");
        }
        assert!(hint("permission denied by policy", Some(&https)).is_none());
    }

    #[test]
    fn socket_hints_mention_length_not_path() {
        let long = format!("unix:///tmp/{}.sock", "x".repeat(120));
        let ep = Endpoint::parse(&long).unwrap();
        let h = hint("path must be shorter than SUN_LEN", Some(&ep)).unwrap();
        assert!(h.contains("this one is 130 bytes"), "{h}");
        assert!(!h.contains("xxxx"), "{h}");
        let missing = Endpoint::parse("unix:///tmp/nope.sock").unwrap();
        let h = hint("No such file or directory (os error 2)", Some(&missing)).unwrap();
        assert!(h.contains("beegit-daemon"), "{h}");
        // Without a Unix endpoint, "No such file" is not about a socket.
        assert!(
            hint(
                "No such file or directory",
                Some(&Endpoint::parse("https://h").unwrap())
            )
            .is_none()
        );
    }

    #[test]
    fn with_hint_appends_only_when_recognized() {
        assert_eq!(with_hint("boom".into(), None), "boom");
        assert!(with_hint("Connection refused".into(), None).contains("; hint: "));
    }
}
