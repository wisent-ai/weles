#!/bin/sh
set -eu
log="$HOME/.stado/weles-figma-acquisition.log"
result="$HOME/recordings/local/figma_personal_access_token/generic_task_result.json"
[ -r "$log" ] || { printf '%s\n' 'Figma acquisition log is unavailable'; exit 1; }
[ -r "$result" ] || { printf '%s\n' 'Figma acquisition result is unavailable'; exit 1; }
grep -E '\[figma_sso\]|\[google_sso\]|FAIL:' "$log" | tail -n 4
/opt/homebrew/bin/node -e '
  const payload = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  const history = Array.isArray(payload.history) ? payload.history : [];
  process.stdout.write(JSON.stringify({
    error: payload.error,
    final_url: payload.final_url,
    history: history.slice(-8).map((step) => ({
      tool: step.tool,
      error: step.error,
      ok: step.ok,
    })),
  }));
' "$result"
