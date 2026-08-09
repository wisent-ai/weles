#!/bin/sh
set -eu

cat >&2 <<'EOF'
Weles still has a Darwin AMD64 worker output, but its node_modules tree contains
native dependencies. Stado v1 has no Darwin AMD64 runner_platform, so an ARM64
runner cannot truthfully reproduce those bytes. Refusing to cross-label an ARM
assembly. Add a Darwin AMD64 fleet runner before declaring darwin-amd64 in
.wisent-release.json.
EOF
exit 78
