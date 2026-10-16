# Keeping up with upstream Scion

BeeGit forked [Scion](https://github.com/CarterT27/scion) at `7d445a0` (2026-10-16) and renamed
everything (amendment B-1 in [contracts/amendments.md](contracts/amendments.md)). The two
projects are not wire- or storage-compatible any more, but most upstream fixes still apply
cleanly once the same rename is applied to them.

## Workflow

```sh
# 1. Update the pristine upstream checkout (git-ignored, lives in ./scion)
git -C scion fetch origin && git -C scion log --oneline 7d445a0..origin/main

# 2. Render the fork point and the new upstream head with the BeeGit rename
scripts/rebrand-upstream.sh scion /tmp/up-old 7d445a0
scripts/rebrand-upstream.sh scion /tmp/up-new origin/main

# 3. Diff upstream's change in BeeGit terms and apply it here
diff -ruN /tmp/up-old /tmp/up-new > /tmp/upstream.patch
git apply --3way /tmp/upstream.patch      # or port hunks by hand

# 4. Verify, then record the new sync point in this file
make check
```

`scripts/rebrand-upstream.sh` applies exactly the rename used for the fork, including the
fix-ups a blind `sed` gets wrong (the 8-byte index magic `BEEGTIDX`, length-prefixed bytes in a
refmodel test, the unchanged Git fixture bundles, external project names such as OpenScion).
Rendering the fork point and comparing it with this repository shows only BeeGit's own changes,
which is a quick way to audit the fork.

## Things to watch

- **Golden vectors** (`testdata/golden/objects`) are regenerated for BeeGit. If upstream changes
  them, regenerate here with `BEEGIT_REGEN_GOLDEN=1 cargo test -p beegit-object --test
  object_golden -- --ignored regenerate_golden_vectors` and update `GOLDEN_DIGEST`.
- **`Cargo.lock`** sorts differently after the rename; let Cargo regenerate it rather than
  applying lockfile hunks.
- **README** is BeeGit's own; upstream benchmark updates belong in
  [upstream/benchmarks.md](upstream/benchmarks.md).

## Sync log

| Date | Upstream commit | Notes |
| --- | --- | --- |
| 2026-10-16 | `7d445a0` | Fork point |
