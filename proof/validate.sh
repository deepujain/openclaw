#!/usr/bin/env bash
set -euo pipefail
side=${1:?expected base or candidate}
case "$side" in base|candidate) ;; *) exit 2;; esac
base=b0f0d4a3f9c1426a1501e97dee51546b7d4ddcec
head=7c7d4514405ea59b21f31b68b26b0dcfdca964e0
parent=d5c8befeec1f17c437969e3ec983144e4edf847c
validator=packages/gateway-protocol/src/compiled/protocol.generated/predicates.js
actions=ui/src/pages/config/updates-actions.test.tsx
updates=ui/src/pages/config/updates.test.ts
mkdir -m 700 "$HOME"
git init -q source
cd source
git config user.name 'Deepak Jain'
git config user.email 'deepujain@gmail.com'
git fetch --no-tags --depth=1 https://github.com/openclaw/openclaw.git "$base"
test "$(git rev-parse FETCH_HEAD)" = "$base"
git checkout -q --detach "$base"
if [[ $side == candidate ]]; then
  git fetch --no-tags --depth=2 https://github.com/deepujain/openclaw.git "$head"
  test "$(git rev-parse FETCH_HEAD)" = "$head"
  test "$(git rev-parse "$head^")" = "$parent"
  git checkout -q --detach "$head"
  if git rebase --onto "$base" "$parent"; then echo 'Expected conflicts on the pinned inputs.' >&2; exit 1; fi
  test "$(git rev-parse HEAD)" = "$base" && test "$(git rev-parse REBASE_HEAD)" = "$head" || exit 1
  test "$(git diff --name-only --diff-filter=U)" = "$(printf '%s\n' "$validator" "$actions" "$updates")"
  git checkout --ours -- "$updates" "$actions"
fi
printf '%s  %s\n' ed921dc2aed45b385554422d25abedea959ba630e194b39cb2f758edaba05f8b /proof/ui-resolutions.patch | sha256sum -c -
git apply --check /proof/ui-resolutions.patch
git apply /proof/ui-resolutions.patch
git add -- "$updates" "$actions"
test "$(git rev-parse ":$actions")" = 0c7c75664b403fef514971d70ed3d45e5e259eca
test "$(git rev-parse ":$updates")" = 9a8111ae9669df0ca64e0cb52335181b85e5fbe4
if [[ $side == candidate ]]; then
  test "$(git diff --name-only --diff-filter=U)" = "$validator"
  git checkout --ours -- "$validator"
fi
export PROTOCOL_SINCE_BASE_SHA="$base" PNPM_CONFIG_STORE_DIR=/work/store PNPM_CONFIG_PACKAGE_IMPORT_METHOD=hardlink PNPM_CONFIG_FROZEN_LOCKFILE=true
export PATH="$HOME/tools/node_modules/.bin:$PATH"
npm install --prefix "$HOME/tools" --no-audit --no-fund pnpm@12.15.0 bun@1.4.4
node --version; pnpm --version
time pnpm install --frozen-lockfile
if [[ $side == candidate ]]; then
  time pnpm gateway:validators:gen
  git add -- "$validator"
  test -z "$(git ls-files --unmerged)"
  git diff --exit-code; git diff --cached --check "$base"
  tree=$(git write-tree)
  (
    export GIT_INDEX_FILE=/work/compare.index
    git read-tree "$tree"
    git ls-tree "$base" -- "$validator" | git update-index --index-info
    test "$(git write-tree)" = 8932583b49e7df299e742a8fd6b04f3f5e6ea504
  )
  blob=$(git rev-parse ":$validator")
  test "$blob" != "$(git rev-parse "$base:$validator")"
  test "$blob" != "$(git rev-parse "$head:$validator")"
  test "$tree" = 0ea8cb4d0192111ffa234d77fe63a01bbe0c20af
  test "$blob" = efdf8e8442a7087e14e856b04d02932b7dcbbfac
  python3 -IB /proof/review.py red-then-apply
  pins=$(python3 -IB /proof/review.py pins)
  read -r tree blob <<< "$pins"
  test "$(git write-tree)" = "$tree"
  test "$(git rev-parse ":$validator")" = "$blob"
  time pnpm gateway:validators:check
  time pnpm protocol:check
  git diff --exit-code
  time python3 -IB /proof/review.py green
else
  code=0
  pnpm test "$updates" --maxWorkers=1 --reporter=json --outputFile=/work/base-regression.json || code=$?
  test "$code" -eq 1
  node --input-type=module <<'REPORT'
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const report = JSON.parse(readFileSync('/work/base-regression.json', 'utf8'));
const failures = report.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'failed');
assert.equal(failures.length, 2);
for (const flag of ['false', 'true']) {
  const failure = failures.find(test => test.title === `shows the owning app's guidance instead of a Gateway update action (previous failure: ${flag})`);
  assert.ok(failure, `Missing expected host-ownership regression (${flag})`);
  const reason = failure.failureMessages.join('\n');
  assert.match(reason, /Managed by OpenClaw\.app/);
  if (flag === 'false') assert.match(reason, /Update status unavailable/);
  console.log(`BASE REGRESSION: ${failure.title}: ${reason.split('\n')[0]}`);
}
REPORT
  git restore --source="$base" --staged --worktree -- "$actions" "$updates"
  tree=$(git rev-parse "$base^{tree}")
fi
node --import ./scripts/tsx.mjs --input-type=module - "$side" <<'VALIDATOR'
import assert from 'node:assert/strict';
import { isUpdateStatusResult } from './packages/gateway-protocol/src/compiled/protocol.generated/predicates.js';
const reply = {sentinel:null, updateAvailable:null, schedule:{channel:'stable', autoEnabled:false,
  install:{kind:'host', host:{owner:'macos-app', displayName:'OpenClaw.app', updateHint:'Update OpenClaw.app to update this Gateway.'}}}};
assert.equal(isUpdateStatusResult(reply), process.argv[2] === 'candidate');
reply.schedule.install.host.owner = 'unknown-owner';
assert.equal(isUpdateStatusResult(reply), false);
VALIDATOR
printf 'Building source tree %s (checkout HEAD %s); the candidate uses the resolved index.\n' "$tree" "$(git rev-parse HEAD)"
time env NODE_OPTIONS=--max-old-space-size=8192 pnpm build:ci-artifacts
git diff --exit-code; git diff --cached --check "$base"
test "$(git write-tree)" = "$tree"
if [[ $side == candidate ]]; then
  test "$(git hash-object "$validator")" = "$blob"
  git cat-file blob "$blob" > /result/predicates.js
  (cd /result && sha256sum predicates.js > SHA256SUMS)
  printf 'base=%s\nhead=%s\ntree=%s\nblob=%s\n' "$base" "$head" "$tree" "$blob" > /result/tree.txt
fi
