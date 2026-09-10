#!/bin/bash
# The arguments of reconcile-spis-public-admission.sh, parsed into the
# variables that script reads: mode, host, source_root, version, trust_file
# and generate_credential. Sourced, not run.

mode=""
host="charless-mac-mini"
source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
version=""
trust_file=""
generate_credential=no
while [ "$#" -gt 0 ]; do
  case "$1" in
    prepare|activate)
      [ -z "$mode" ] || { printf 'mode specified more than once\n' >&2; exit 2; }
      mode="$1"
      ;;
    --host)
      host="$2"; shift
      ;;
    --version)
      version="$2"; shift
      ;;
    --source)
      source_root="$2"; shift
      ;;
    --spis-trust-file)
      trust_file="$2"; shift
      ;;
    --generate-credential)
      generate_credential=yes
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done
[ "$mode" = "prepare" ] || [ "$mode" = "activate" ] || {
  printf 'usage: %s prepare|activate --spis-trust-file PATH [--host HOST] [--version VERSION] [--source WELES_CHECKOUT] [--generate-credential]\n' "$0" >&2
  exit 2
}
[ -n "$trust_file" ] || { printf '%s\n' '--spis-trust-file is required' >&2; exit 2; }
[ -d "$source_root" ] || { printf 'Weles source directory is unavailable: %s\n' "$source_root" >&2; exit 2; }
source_root="$(cd "$source_root" && pwd -P)"
[ -d "$(dirname "$trust_file")" ] || { printf 'Spis trust-file parent is unavailable: %s\n' "$(dirname "$trust_file")" >&2; exit 2; }
