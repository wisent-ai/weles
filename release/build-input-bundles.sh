#!/bin/bash
set -euo pipefail

root="${1:-.wisent-output/inputs}"
mkdir -p "$root/repos"
root="$(cd "$root" && pwd)"

bundle_repo() {
  name="$1"
  repository="$2"
  revision="$3"
  mirror="$root/repos/$name.git"
  bundle="$root/$name.bundle"

  if [ -d "$mirror" ]; then
    git -C "$mirror" remote set-url origin "$repository"
    git -C "$mirror" fetch --prune origin
  else
    git clone --mirror "$repository" "$mirror"
  fi
  git -C "$mirror" cat-file -e "$revision^{commit}"
  git -C "$mirror" update-ref refs/heads/release-input "$revision"
  git -C "$mirror" bundle create "$bundle" refs/heads/release-input
  git bundle verify "$bundle" >/dev/null
  shasum -a 256 "$bundle"
}

bundle_repo \
  weles-client \
  https://github.com/wisent-ai/weles-client.git \
  82236df96b8763c9442d6e1bc715c414e5905510
bundle_repo \
  wisent-cost-tracker \
  https://github.com/wisent-ai/wisent-cost-tracker.git \
  5c07c0287beaeafec828ad2744baf6239f3ff0e1
