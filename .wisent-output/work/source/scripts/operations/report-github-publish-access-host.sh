#!/bin/sh
set -eu
if ! command -v gh >/dev/null 2>&1; then
  printf '{"gh":false,"authenticated":false}\n'
  exit 0
fi
if gh auth status >/dev/null 2>&1; then
  printf '{"gh":true,"authenticated":true}\n'
else
  printf '{"gh":true,"authenticated":false}\n'
fi
