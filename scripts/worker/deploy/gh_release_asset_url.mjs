#!/usr/bin/env node
// Extract a release asset's API download URL from the GitHub release JSON on
// stdin, selecting by asset name given as the argument. Prints the URL (empty
// if not found). Uses only the node runtime the worker already runs on — no gh,
// no jq. The URL is fetched with an octet-stream Accept header plus the worker's
// existing token to pull the asset from the private weles release.
const want = process.argv[process.argv.length - 1];
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  try {
    const rel = JSON.parse(raw);
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const hit = assets.find((a) => a && a.name === want);
    process.stdout.write(hit && hit.url ? hit.url : "");
  } catch {
    process.stdout.write("");
  }
});
