#!/bin/bash
set -euo pipefail

host="${1:-charless-mac-mini}"
version="${2:-0.5.46}"
product="weles-worker"
logical_service="weles-admission"
legacy_service="com.wisent.always-on.weles-api"
managed_label="com.wisent.weles-admission"
readiness_url="http://127.0.0.1:8788/healthz"
stado_bin="${STADO_BIN:-stado}"

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
bridge_dir="${script_dir}/migrations/weles-admission-bootstrap"
launcher="${bridge_dir}/darwin-arm/weles-api-launcher"
standby="${bridge_dir}/standby"
active="${bridge_dir}/active"
declaration="${script_dir}/weles-admission-service.json"
work_dir="${HOME}/.stado/work/weles-admission-migration"
bridge_archive="${work_dir}/weles-admission-bootstrap.tar.gz"
standby_staged="${work_dir}/standby"
active_staged="${work_dir}/active"
remote_launcher="/Users/charles/.stado/files/weles-api-launcher"
remote_marker="/Users/charles/.stado/files/weles-admission-standby"

release_is_committed() {
  /usr/bin/printf '%s' "$1" \
    | /usr/bin/jq -e \
        --arg host "${host}" \
        --arg version "${version}" \
        '.targets[] | select(.target == $host) | .observed.phase == "committed" and .observed.active_version == $version and .observed.rollout_generation == .desired.rollout_generation' \
        >/dev/null
}

release_status=$("${stado_bin}" release status "${product}" --json || true)
if release_is_committed "${release_status}"; then
  exit 0
fi

/bin/mkdir -p "${work_dir}"
/usr/bin/install -m 600 "${standby}" "${standby_staged}"
/usr/bin/install -m 600 "${active}" "${active_staged}"

if ! "${stado_bin}" service show "${logical_service}" --host "${host}" --json >/dev/null 2>&1; then
  "${stado_bin}" service file-sync "${legacy_service}" \
    --host "${host}" \
    --source-file "${launcher}" \
    --target-file "${remote_launcher}" \
    --executable
  "${stado_bin}" service file-sync "${legacy_service}" \
    --host "${host}" \
    --source-file "${standby_staged}" \
    --target-file "${remote_marker}"
  "${stado_bin}" service declare --file "${declaration}"
  "${stado_bin}" service deploy "${logical_service}" \
    --host "${host}" \
    --from "${remote_launcher}" \
    --launchd-label "${managed_label}" \
    --as-launch-agent
fi

/usr/bin/tar -czf "${bridge_archive}" -C "${bridge_dir}" darwin-arm
"${stado_bin}" service update "${logical_service}" \
  --host "${host}" \
  --from-archive "${bridge_archive}" \
  --json

"${stado_bin}" service file-sync "${logical_service}" \
  --host "${host}" \
  --source-file "${active_staged}" \
  --target-file "${remote_marker}"

if "${stado_bin}" service show "${legacy_service}" --host "${host}" --json >/dev/null 2>&1; then
  "${stado_bin}" service stop "${legacy_service}" \
    --host "${host}" \
    --listener-url "${readiness_url}" \
    --json
fi

"${stado_bin}" service bootout "${managed_label}" \
  --host "${host}" \
  --domain user \
  --json

if ! "${stado_bin}" service release "${logical_service}" \
  --host "${host}" \
  --product "${product}" \
  --version "${version}" \
  --readiness-url "${readiness_url}" \
  --readiness-timeout-seconds 90 \
  --require-release-version \
  --json; then
  "${stado_bin}" service bootout "${managed_label}" \
    --host "${host}" \
    --domain user \
    --json || true
  "${stado_bin}" service restart "${logical_service}" --host "${host}" --json || true
  exit 1
fi

if "${stado_bin}" service show "${legacy_service}" --host "${host}" --json >/dev/null 2>&1; then
  "${stado_bin}" service retire "${legacy_service}" --host "${host}" --json
fi

final_status=$("${stado_bin}" release status "${product}" --json || true)
/usr/bin/printf '%s\n' "${final_status}"
release_is_committed "${final_status}"
