#!/usr/bin/env bash
# Produce a "BeeGit-renamed" copy of an upstream Scion checkout, so upstream changes can be
# diffed and ported (docs/upstream-sync.md). Applies exactly the mechanical rename of
# amendment B-1; it does not touch this repository.
#
#   scripts/rebrand-upstream.sh UPSTREAM_GIT_DIR OUT_DIR [REV]
#
#   UPSTREAM_GIT_DIR  a clone of https://github.com/CarterT27/scion (e.g. ./scion)
#   OUT_DIR           must not exist; receives the renamed tree of REV (default HEAD)
set -euo pipefail
[ $# -ge 2 ] || { sed -n '2,10p' "$0"; exit 2; }
SRC="$1"; OUT="$2"; REV="${3:-HEAD}"
[ ! -e "$OUT" ] || { echo "rebrand: $OUT already exists" >&2; exit 1; }
mkdir -p "$OUT"
git -C "$SRC" archive "$REV" | tar -x -C "$OUT"
rm -rf "$OUT/.workflow"

# 1. File contents (text files only; external project names restored afterwards).
grep -rIl -i scion "$OUT" | while IFS= read -r f; do
  sed -i -e 's/SCION/BEEGIT/g' -e 's/Scion/BeeGit/g' -e 's/scion/beegit/g' \
         -e 's/OpenBeeGit/OpenScion/g' -e 's/openbeegit/openscion/g' "$f"
done

# 2. Paths, deepest first.
find "$OUT" -depth -iname '*scion*' | while IFS= read -r p; do
  b="$(basename "$p")"; mv "$p" "$(dirname "$p")/${b//scion/beegit}"
done

# 3. Fix-ups that a plain rename gets wrong.
sed -i 's/BEEGITIDX/BEEGTIDX/g' "$OUT/crates/beegit-wc/src/index.rs" "$OUT/SPEC.md" "$OUT"/docs/*.md
sed -i 's/sCiOn/bEeGiT/g; s/ScIoN/BeEgIt/g' \
  "$OUT/crates/beegit-object/tests/object_grammar.rs" \
  "$OUT/crates/beegit-wc/tests/checkout_safety.rs" \
  "$OUT/crates/beegit-wc/tests/local_fs_safe.rs"
sed -i 's/let mut m = vec!\[1, 23\];/let mut m = vec![1, 25];/; s/m.extend_from_slice(&\[0, 0, 0, 0, 13\]);/m.extend_from_slice(\&[0, 0, 0, 0, 14]);/' \
  "$OUT/crates/beegit-refmodel/tests/refmodel_apply_delta.rs"
# The committed Git fixture bundles still say "Scion Fixture Author".
sed -i 's/author BeeGit Fixture Author/author Scion Fixture Author/' \
  "$OUT/crates/beegit-testkit/tests/corpus_git.rs"
sed -i 's/"BeeGit Fixture Author"/"Scion Fixture Author"/; s/"BeeGit Fixture Committer"/"Scion Fixture Committer"/' \
  "$OUT/corpus/git/build-synthetic.sh"

if command -v cargo >/dev/null; then (cd "$OUT" && cargo fmt --all >/dev/null 2>&1) || true; fi
echo "rebrand: renamed tree of $REV written to $OUT"
echo "rebrand: object goldens are NOT regenerated; compare testdata/ by hand (amendment B-1)"
