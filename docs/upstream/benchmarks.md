# Benchmarks (inherited from upstream Scion)

> **Provenance.** These measurements were taken by the upstream Scion project
> (commit `7d445a0` and earlier) on an Apple M4 Pro, before the fork. The text was renamed
> to "BeeGit" mechanically, but **no number on this page was measured on BeeGit or on our
> hardware**. Re-running them on Linux and on the K3s VPS is task B-PERF-1 in
> [the plan](../plan.html). The benchmark tooling itself (runner, scripts) is part of BeeGit.


The [benchmark runner](../../crates/beegit-conformance/examples/benchmark.rs) compares BeeGit with
Git on the four synthetic workloads used by
[OpenScion](https://github.com/tinyhumansai/openscion/blob/main/benchmarks/README.md).
These are local measurements of this implementation, using its own deterministic fixture.

Median wall-clock times, measured 2026-10-14 on an Apple M4 Pro with 24 GiB RAM,
macOS 26.6.2, Rust 1.98.0, and Git 2.56.0. BeeGit was built in release mode from
`9d27736` plus the benchmark runner. Each file contains 4 KiB of seeded pseudorandom bytes,
spread across 10 directories; the 1,000-file case uses seven runs and the 10,000-file case
uses five. All times are milliseconds; lower is better.

| Scenario | Git, 1k files | BeeGit, 1k | Git, 10k files | BeeGit, 10k |
| --- | ---: | ---: | ---: | ---: |
| Import directory | 456.6 | 39.7 | 3,907.1 | 500.5 |
| Commit one changed file | 33.6 | 36.8 | 166.9 | 203.6 |
| Full clone / checkout | 242.2 | 170.1 | 2,223.9 | 1,590.2 |
| One-directory clone / checkout | 89.8 | 29.8 | 159.7 | 173.2 |

BeeGit imports and materializes the full tree faster in this setup. Git commits faster at
both sizes and is slightly faster for the 10k-file sparse case. Sparse checkout materializes
100 or 1,000 files respectively and fetches exactly that many blobs plus two trees.

Reproduce the measurements (requires Git and the build prerequisites below):

```sh
cargo run --release -p beegit-conformance --example benchmark -- 100 7
cargo run --release -p beegit-conformance --example benchmark -- 1000 5
# Quick correctness check: 10 directories × 2 files, one run
cargo run --release -p beegit-conformance --example benchmark -- 2 1
```

The positional arguments are files per directory and run count (defaults: `100 5`).
The runner prints each sample to stderr and a median table to stdout, uses a fresh temporary
repository and server per run, and removes its scratch files afterward. Setup, fixture
generation, authentication, and byte-for-byte checkout verification are outside the timers.

- **Import:** Git runs `init`, `add -A`, and `commit`. BeeGit reads the fixture files, hashes
  and uploads blobs in batches of 256, creates a parentless changeset, and creates a ref
  through the write APIs. This measures directory ingestion, not `beegit-import`'s Git-history
  migration; fixture path enumeration is prepared beforehand.
- **Commit:** Change one byte in one file of the full working copy, then time Git
  `commit -a` or BeeGit's working-copy commit, including status scanning and blob upload.
  Neither side includes a subsequent push or land.
- **Full checkout:** Git uses `clone --no-local` to build and transfer a pack; BeeGit uses
  `WorkingCopy::checkout` with its default 256-object fetch batches.
- **Sparse checkout:** Git uses `clone --no-local --filter=blob:none --sparse` followed by
  `sparse-checkout set dir0000`, with filtering enabled on the source. BeeGit checks out
  only `dir0000`. Both outputs are checked against the fixture, including absent paths
  outside the selected directory.

These measurements use an in-process BeeGit server and client over real loopback TLS/gRPC,
with in-memory metadata and object storage, elevated test rate limits, and no daemon.
BeeGit still performs authorization, BLAKE3 verification, and production zstd compression,
but does not pay CockroachDB/S3 latency or durable server writes. Git uses disk-backed
storage, compression, packing, and subprocesses; BeeGit's CLI process startup is excluded.
OS caches are not flushed, and recently written working copies can trigger timestamp-related
rehashing during commit. At 10k files, Git's commit samples ranged from 67.5 to 253.8 ms.
These are small, single-client, single-commit workloads, not production throughput results
or a direct comparison with OpenScion's published timings.

### Real repository with persistent storage

The [CLI benchmark](../../scripts/benchmark-git.py) also exercises the full default-branch history
of `pingdotgg/t3code` at `bf8ffe81a63c82d3de5fbaa9991fd5f30034a452`: 5,573 commits and
28,068 materialized files. These 2026-10-14 measurements use release binaries, local HTTPS,
and Docker CockroachDB/MinIO with the default permissions, verification, and rate limits.
Submodule contents are omitted on both sides.

Median seconds, with three fresh-directory checkout trials after a separate first measurement:

| Checkout | BeeGit before | BeeGit after | Less elapsed time |
| --- | ---: | ---: | ---: |
| Full tree, direct server | 30.43 | 14.49 | 52% |
| Full tree, warmed daemon | 18.62 | 10.19 | 45% |
| `apps/web`, direct server (1,521 files) | 2.28 | 0.95 | 58% |
| `apps/web`, warmed daemon | 0.48 | 0.45 | 6% |

Git's full-tree checkout was 2.47 seconds in the direct comparison. In the expanded
resource-instrumented run, Git took 3.03 seconds for the full tree and 0.21 seconds for
`apps/web`. Compare before and after within a row: direct full checkout repeats the original
procedure, while daemon and sparse workloads use the expanded runner. Back-to-back controls
showed no material change in status, history, or single-file-read time. OS caches are not
flushed; these are single-client local measurements, not controlled cold-cache or WAN tests.

A final run against a freshly imported store measured 14.96 seconds for direct full checkout
versus Git's 2.90 seconds, and 0.97 seconds for sparse checkout versus Git's 0.21 seconds.
Every checkout passed hash and mode checks. The complete release import into an empty
CockroachDB database and MinIO prefix took 1,397.59 seconds (23m18s), importing all 5,573
commits and 84,696 blobs with the same final graph identifier as the original import.
The local Git full-history clone without checkout took 3.56 seconds; BeeGit import also
constructs and durably publishes server history, so these operations have different costs.
The earlier full import used a development build and is not a controlled before/after
timing. Reimporting unchanged history uploaded nothing (0.060 seconds versus Git fetch's
0.031 seconds). No-change status, history, and single-file reads remain broadly unchanged.

The expanded runner records every sample, client CPU and peak RSS on macOS, sampled server
CPU/RSS, RPC and byte counters, and logical metadata calls/object-storage requests when the
server exports them. It verifies checkout file hashes and executable/symlink modes outside
the timers, checks matching sparse scopes, and removes its temporary working copies.
The server exposes storage snapshots as `beegit_storage_access` and `beegit_storage_bytes`
on its existing admin metrics listener; scraping does not query the storage backends.

With a local server whose `main` matches the Git mirror's `HEAD`, and an optional daemon:

```sh
python3 scripts/benchmark-git.py --help
python3 scripts/benchmark-git.py --self-test
python3 scripts/benchmark-git.py \
  --repo /path/to/repo.git --beegit target/release/beegit \
  --importer target/release/beegit-import --endpoint https://127.0.0.1:18443 \
  --ca-file /path/to/ca.pem --token-file /path/to/raw-beegit-token \
  --work-dir /tmp/beegit-benchmark --output /tmp/beegit-results.json \
  --daemon-endpoint unix:///path/to/daemon.sock --server-pid SERVER_PID
```

The work directory must not exist. Omit `--daemon-endpoint` when testing only direct access;
`--importer` adds local full-history Git clones and no-change synchronization checks.

### Concurrent CI workloads

[`scripts/benchmark-scaling.py`](../../scripts/benchmark-scaling.py) measures shared-cache job
throughput, p50/p95 job latency, and one-file commit publication as concurrency increases.
It runs each implementation's waves separately in randomized order, with two explicit
warmups and three measured waves by default. Checkout bootstrap is inside the timer;
fixture creation, service startup, cache priming, and correctness checks are separate.

Git baselines include independent shared clones borrowing objects from a ready mirror
containing only the default branch, with a reachable commit graph prepared outside the timers,
cone-mode sparse-index clients, fresh shallow filtered clones, and fresh filtered clones
with default-branch history. Cone mode also includes files in ancestor directories; the
runner validates and reports those additional files. Query jobs read a file and the first
100 first-parent repository history entries using the ready Git mirror directly, without charging a
clone. Commit workloads change one file from a pinned parent, with distinct fresh content
per job and run:
Git commits and pushes a private ref into a disposable receiver, while BeeGit creates a
server-visible changeset without updating `main`. Git keeps its default durability;
BeeGit keeps production authorization, integrity verification, and durability.

```sh
python3 scripts/benchmark-scaling.py --self-test
python3 scripts/benchmark-scaling.py \
  --repo /path/to/repo.git --beegit target/release/beegit \
  --endpoint https://127.0.0.1:18444 --metrics-url http://127.0.0.1:19465/metrics \
  --daemon-endpoint unix:///path/to/daemon.sock \
  --ca-file /path/to/ca.pem --token-file /path/to/raw-beegit-token \
  --server-pid SERVER_PID --daemon-pid DAEMON_PID \
  --containers COCKROACH_CONTAINER,MINIO_CONTAINER \
  --concurrency 1,4,8 --scopes apps/web/src/lib,apps/web \
  --work-dir /tmp/beegit-scaling --output /tmp/beegit-scaling.json
```

The output retains every wave and job sample, per-job client CPU/peak RSS on macOS,
server/daemon CPU deltas and sampled RSS, authoritative storage/byte counters, received Git
pack sizes, and materialized bytes. `--containers` adds dedicated backend CPU and memory
from Docker cgroup v2 counters; without it, CPU accounting excludes the database and object
store. Container memory includes page cache and is not directly comparable to host-process
RSS; CPU snapshots include background work and observer overhead. Measured waves refuse
to run alongside Cargo builds or workspace tests.
Temporary Git repositories and job directories are removed; resource reports remain, and
BeeGit's unreferenced benchmark changesets remain in the configured server. Use a disposable
benchmark server. This is single-machine concurrency testing, not a demonstration of
horizontal scaling, virtualized checkout, enormous-repository behavior, or full-fleet cost.

On the same pinned `t3code` snapshot, the final matrix passed 897 measured jobs across
concurrency 1, 4, and 8 and working sets of 107 and 1,521 files. A separate seven-wave
confirmation passed another 504 jobs. The confirmation below uses the 107-file scope,
a warmed shared daemon, and the fastest measured Git baseline for each row. Both final
runs use a main-only Git receiver with a prepared commit graph. Times are median seconds
per wave, including all jobs in that wave:

| Workload | Concurrent jobs | Git | BeeGit | Speedup |
| --- | ---: | ---: | ---: | ---: |
| Fresh sparse checkout | 1 | 0.102 | 0.044 | 2.34× |
| Fresh sparse checkout | 8 | 0.333 | 0.216 | 1.54× |
| One-file commit, published | 1 | 0.424 | 0.107 | 3.96× |
| One-file commit, published | 8 | 1.059 | 0.220 | 4.82× |

Every BeeGit wave in these four confirmation cases was faster than every corresponding Git
wave. The eight-job checkout used 1.00 accounted CPU-seconds versus Git's 2.24; the eight-job
write wave used 0.54 versus 8.33, including BeeGit's server, daemon, CockroachDB, and MinIO.
Client CPU values are rounded to 0.01 seconds by the macOS observer, so reported zeroes
for short commands do not mean zero work. Warm daemon checkout waves made zero origin
object-storage reads. Commit provisioning is outside the commit timer on both sides;
the timed operation includes scanning, committing, and making the change server-visible.

Git still wins elsewhere: for eight 1,521-file checkouts, the final matrix measured 1.01
seconds for shared-mirror Git versus 2.43 for BeeGit's daemon. An eight-job file/history
query wave was 0.032 seconds versus 0.112. These results establish advantages for particular
local job workloads, not a general replacement for Git or a reproduction of fleet-scale claims.

The hill climb retained a checkout change that obtains the post-rename stat through the
already-open descriptor, avoiding another parent-directory walk. Its isolated three-wave
experiment reduced large-checkout time by 12–14%, with lower CPU at all three concurrency
levels; the complete rerun showed a smaller gain at eight jobs. A second experiment that
forwarded compressed frames from the node daemon was rejected: it did not improve on the
retained variant over the local socket. Authorization, hashing, atomic replacement,
journaling, and racy timestamp checks remain enabled.

[Compact results and timing/CPU samples](../../benchmarks/t3code-scaling.json) include every final
and confirmation case plus the selected hill-climb samples. Exploratory before/iteration
runs inherited all Git refs and had no prepared commit graph; they assess only the BeeGit
runtime change. The headline Git comparisons above use the corrected final fixtures.

