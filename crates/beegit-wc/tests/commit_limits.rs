//! Upload sizing (amendment B-3): a blob above the server's `limits.max_blob_bytes` is refused
//! as TOO_LARGE before any UploadObjects request is sent, and blobs are batched so that one
//! request carries at most 32 MiB or a single larger blob (proxies cap request bodies).

mod commit_support;

use beegit_core::{ErrorCode, Mode};
use beegit_server::testing::{InProcessServer, ServerTestOpts};
use beegit_wc::testing::{Scenario, checkout_at, write_files};
use commit_support::alice;
use std::sync::Arc;

const MIB: usize = 1 << 20;

async fn server_with_max_blob(bytes: u64) -> InProcessServer {
    InProcessServer::start(ServerTestOpts {
        tweak: Some(Arc::new(move |c| c.limits.max_blob_bytes = bytes)),
        ..ServerTestOpts::default()
    })
    .await
}

/// `beegit_rpc_duration_seconds` samples recorded for `rpc` (0 when never called).
fn rpc_count(srv: &InProcessServer, rpc: &str) -> u64 {
    let needle = format!("rpc=\"{rpc}\"");
    srv.ctx()
        .metrics
        .render()
        .lines()
        .filter(|l| l.starts_with("beegit_rpc_duration_seconds_count") && l.contains(&needle))
        .filter_map(|l| l.rsplit(' ').next()?.parse::<u64>().ok())
        .sum()
}

fn noise(len: usize, seed: u8) -> Vec<u8> {
    (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed) ^ ((i >> 8) as u8))
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::unwrap_used, clippy::panic)]
async fn blob_above_server_limit_is_refused_before_upload() {
    let srv = server_with_max_blob(9 * MIB as u64).await;
    let s = Scenario::new(srv.client(Some(&alice())).await).unwrap();
    let mut wc = checkout_at(&s, "main", None).await.unwrap();
    let big = noise(10 * MIB, 1);
    write_files(&wc, &[("big.bin", Mode::File, &big)]).unwrap();
    let err = wc
        .commit(b"too big", b"a <a@example.com>", None)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::TooLarge, "{err:?}");
    assert!(err.message.contains("max_blob_bytes"), "{}", err.message);
    assert_eq!(
        rpc_count(&srv, "UploadObjects"),
        0,
        "no upload was attempted"
    );

    // Under the limit the same path uploads and commits.
    let ok = noise(8 * MIB, 2);
    write_files(&wc, &[("big.bin", Mode::File, &ok)]).unwrap();
    wc.commit(b"fits", b"a <a@example.com>", None)
        .await
        .unwrap();
    assert_eq!(rpc_count(&srv, "UploadObjects"), 1);
}

#[tokio::test(flavor = "multi_thread")]
#[allow(clippy::unwrap_used, clippy::panic)]
async fn uploads_are_batched_before_a_blob_would_overflow_the_batch() {
    let srv = server_with_max_blob(100 * MIB as u64).await;
    let s = Scenario::new(srv.client(Some(&alice())).await).unwrap();
    let mut wc = checkout_at(&s, "main", None).await.unwrap();
    // 31 MiB + 20 MiB: the old rule sent both in one 51 MiB request; now the 20 MiB blob
    // starts a new batch.
    let a = noise(31 * MIB, 3);
    let b = noise(20 * MIB, 4);
    write_files(&wc, &[("a.bin", Mode::File, &a), ("b.bin", Mode::File, &b)]).unwrap();
    wc.commit(b"two blobs", b"a <a@example.com>", None)
        .await
        .unwrap();
    assert_eq!(rpc_count(&srv, "UploadObjects"), 2);
}
