//! gRPC-Web transport: the server accepts `application/grpc-web` next to plain gRPC, and a
//! `grpc-web+https://` client gets statuses and the SPEC 7.1 epoch trailers from the response
//! body, so a proxy that drops HTTP/2 trailers (Cloudflare Tunnel) cannot break calls.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // test-only helpers outside #[test] fns

mod core_support;

use beegit_proto::{BeeGitClient, Endpoint, v1};
use beegit_server::testing::InProcessServer;
use core_support::{alice, opts};
use http_body_util::BodyExt as _;
use tower::ServiceExt as _;

fn grpc_web_endpoint(srv: &InProcessServer) -> Endpoint {
    let Endpoint::Https(url) = &srv.endpoint else {
        panic!("test server is HTTPS")
    };
    let ep = Endpoint::parse(&format!("grpc-web+{url}")).unwrap();
    assert!(matches!(ep, Endpoint::GrpcWeb(_)));
    ep
}

#[tokio::test(flavor = "multi_thread")]
async fn grpc_web_client_round_trips_unary_streaming_errors_and_epochs() {
    let srv = InProcessServer::start(opts()).await;
    let ep = grpc_web_endpoint(&srv);
    let c = BeeGitClient::connect(&ep, srv.tls.clone(), Some(srv.token_for(&alice())))
        .await
        .unwrap();
    assert!(c.is_grpc_web());

    // Unary, with the epochs recovered from the body-encoded trailers.
    let me = c.auth().who_am_i(v1::WhoAmIRequest {}).await.unwrap();
    assert_eq!(me.into_inner().principal, "github:alice");
    assert!(c.last_epochs().is_some(), "epoch trailers were not decoded");

    let main = c
        .objects()
        .resolve_ref(v1::ResolveRefRequest {
            name: "main".into(),
            at_version: None,
        })
        .await
        .unwrap()
        .into_inner();
    assert_eq!(main.version, 1);

    // Server streaming ends with a status carried in the body.
    let mut stream = c
        .objects()
        .get_objects(v1::GetObjectsRequest {
            ids: vec![main.target.clone()],
            offset: None,
            length: None,
        })
        .await
        .unwrap()
        .into_inner();
    let mut chunks = 0;
    while let Some(chunk) = stream.message().await.unwrap() {
        assert_eq!(chunk.id, main.target);
        chunks += 1;
    }
    assert!(chunks >= 1);

    // An error status arrives intact (code and message).
    let anon = c.with_token(None);
    let err = anon
        .auth()
        .who_am_i(v1::WhoAmIRequest {})
        .await
        .unwrap_err();
    assert_eq!(err.code(), tonic::Code::Unauthenticated, "{err:?}");

    // Plain gRPC still works against the same server.
    let plain = srv.client(Some(&alice())).await;
    assert!(!plain.is_grpc_web());
    plain.auth().who_am_i(v1::WhoAmIRequest {}).await.unwrap();
}

/// On the wire, a gRPC-Web response has no HTTP trailers at all: the status and the epochs
/// are a trailer frame (flag 0x80) inside the body. This is the property that survives
/// proxies which drop trailers.
#[tokio::test(flavor = "multi_thread")]
async fn grpc_web_response_carries_status_and_epochs_in_the_body() {
    let srv = InProcessServer::start(opts()).await;
    let raw = srv.client(None).await.channel();
    let token = srv.token_for(&alice());
    let req = http::Request::builder()
        .method(http::Method::POST)
        .version(http::Version::HTTP_2)
        .uri(format!("{}/beegit.v1.AuthService/WhoAmI", srv.endpoint))
        .header("content-type", "application/grpc-web+proto")
        .header("x-grpc-web", "1")
        .header("authorization", format!("Bearer {token}"))
        // An empty WhoAmIRequest: uncompressed flag + zero length.
        .body(tonic::body::Body::new(http_body_util::Full::new(
            bytes::Bytes::from_static(&[0, 0, 0, 0, 0]),
        )))
        .unwrap();
    let resp = raw.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), http::StatusCode::OK);
    let ct = resp.headers()["content-type"].to_str().unwrap().to_owned();
    assert!(ct.starts_with("application/grpc-web"), "{ct}");

    let collected = resp.into_body().collect().await.unwrap();
    assert!(
        collected.trailers().is_none(),
        "gRPC-Web must not use HTTP trailers"
    );
    let body = collected.to_bytes();
    let mut rest = &body[..];
    let mut trailer_block = None;
    while rest.len() >= 5 {
        let flag = rest[0];
        let len = u32::from_be_bytes([rest[1], rest[2], rest[3], rest[4]]) as usize;
        let frame = &rest[5..5 + len];
        if flag & 0x80 != 0 {
            trailer_block = Some(String::from_utf8_lossy(frame).to_lowercase());
        }
        rest = &rest[5 + len..];
    }
    let block = trailer_block.expect("a trailer frame in the body");
    assert!(block.contains("grpc-status:0"), "{block}");
    assert!(block.contains("beegit-tier:server"), "{block}");
    assert!(block.contains("beegit-policy-epoch:"), "{block}");
}

/// gRPC-Web over HTTP/1.1 (B-WEB-3): a TLS client without ALPN (Node's https agent, used by
/// the Vite dev proxy) gets HTTP/1.1 and a normal gRPC-Web answer.
#[tokio::test(flavor = "multi_thread")]
async fn grpc_web_works_over_http1_without_alpn() {
    let srv = InProcessServer::start(opts()).await;
    let ca = srv.tls.as_ref().unwrap().ca_pem.clone().unwrap();
    let mut roots = rustls::RootCertStore::empty();
    for c in rustls_pemfile::certs(&mut ca.as_slice()) {
        roots.add(c.unwrap()).unwrap();
    }
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth(); // no ALPN
    let tcp = tokio::net::TcpStream::connect(srv.addr).await.unwrap();
    let name = rustls::pki_types::ServerName::try_from("127.0.0.1").unwrap();
    let tls = tokio_rustls::TlsConnector::from(std::sync::Arc::new(cfg))
        .connect(name, tcp)
        .await
        .unwrap();
    let (mut send, conn) = hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tls))
        .await
        .unwrap();
    tokio::spawn(conn);
    let req = http::Request::builder()
        .method(http::Method::POST)
        .uri("/beegit.v1.AuthService/WhoAmI")
        .header("host", "127.0.0.1")
        .header("content-type", "application/grpc-web+proto")
        .header("x-grpc-web", "1")
        .header(
            "authorization",
            format!("Bearer {}", srv.token_for(&alice())),
        )
        .body(http_body_util::Full::new(bytes::Bytes::from_static(&[
            0, 0, 0, 0, 0,
        ])))
        .unwrap();
    let resp = send.send_request(req).await.unwrap();
    assert_eq!(resp.version(), http::Version::HTTP_11);
    assert_eq!(resp.status(), http::StatusCode::OK);
    let body = resp.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8_lossy(&body).to_lowercase();
    assert!(text.contains("grpc-status:0"), "{text}");
    assert!(text.contains("github:alice"), "{text}");
}

/// `structured` (amendment B-5): Log and GetChangesets answer with the structured view, so
/// the web UI needs no canonical-encoding decoder; without it the encoding is unchanged.
#[tokio::test(flavor = "multi_thread")]
async fn structured_changeset_views() {
    let srv = InProcessServer::start(opts()).await;
    let c = srv.client(Some(&alice())).await;
    let main = c
        .objects()
        .resolve_ref(v1::ResolveRefRequest {
            name: "main".into(),
            at_version: None,
        })
        .await
        .unwrap()
        .into_inner()
        .target;
    let log = |structured| v1::LogRequest {
        from: main.clone(),
        path: None,
        first_parent_only: false,
        limit: 1,
        page_token: Vec::new(),
        structured,
    };
    use v1::changeset_item::View;
    let plain = c.query().log(log(false)).await.unwrap().into_inner();
    assert!(matches!(
        plain.entries[0].changeset.as_ref().unwrap().view,
        Some(View::Encoded(_))
    ));
    let s = c.query().log(log(true)).await.unwrap().into_inner();
    let Some(View::FilteredView(v)) = &s.entries[0].changeset.as_ref().unwrap().view else {
        panic!("structured log entry")
    };
    assert!(!v.filtered, "nothing was removed");
    assert!(!v.root_tree.is_empty() && !v.meta.is_empty());
    assert!(s.entries[0].meta.is_some());

    let g = c
        .query()
        .get_changesets(v1::GetChangesetsRequest {
            ids: vec![main.clone()],
            structured: true,
        })
        .await
        .unwrap()
        .into_inner();
    assert!(matches!(g.items[0].view, Some(View::FilteredView(_))));
}
