#!/usr/bin/env bash
# Cut a release through GitHub Actions: bump the version, push the tag, follow the
# release workflow until the notarized zip is published.
#
#   bash scripts/ship.sh            # patch (0.1.0 → 0.1.1)
#   bash scripts/ship.sh minor      # or major, or an explicit version like 0.2.0
#   npm run ship -- minor
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BUMP="${1:-patch}"

[ "$(git rev-parse --abbrev-ref HEAD)" = main ] || { echo "error: release from main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "error: working tree not clean" >&2; exit 1; }
git fetch -q origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "error: main is not in sync with origin/main (pull or push first)" >&2; exit 1; }

echo "› Checks before tagging…"
npm run typecheck --silent
npm test --silent >/dev/null

TAG="$(npm version "$BUMP" -m "Release %s")"
echo "› Pushing $TAG…"
git push -q --follow-tags origin main

echo "› Waiting for the release workflow to start…"
RUN=""
for _ in $(seq 1 30); do
  RUN="$(gh run list --workflow release.yml --branch "$TAG" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)"
  [ -n "$RUN" ] && break
  sleep 4
done
[ -n "$RUN" ] || { echo "error: no release run appeared for $TAG — check the Actions tab" >&2; exit 1; }

gh run watch "$RUN" --exit-status --interval 30
echo "✓ Released: $(gh release view "$TAG" --json url -q .url)"
