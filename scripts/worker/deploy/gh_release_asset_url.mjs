#!/usr/bin/env node
// Extract a release asset's API download URL from the GitHub release JSON on
// stdin, selecting by asset name given as the argument. Prints the URL (empty
// if not found). Uses only the node runtime the worker already runs on — no gh,
// no jq. The URL is fetched with an octet-stream Accept header plus the worker's
// existing token to pull the asset from the private weles release.
const selector = process.argv[process.argv.length - 1];
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { raw += d; });
process.stdin.on("end", () => {
  try {
    const rel = JSON.parse(raw);
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const hit = selector.startsWith("latest-vault:")
      ? assets
          .filter((asset) => {
            const base = selector.slice("latest-vault:".length);
            const versionedPrefix = base.endsWith(".json") ? `${base.slice(0, -".json".length)}.` : `${base}.`;
            return asset && (asset.name === base || (asset.name?.startsWith(versionedPrefix) && asset.name.endsWith(".json")));
          })
          .sort((left, right) => Date.parse(right.updated_at ?? right.created_at ?? 0) - Date.parse(left.updated_at ?? left.created_at ?? 0))[0]
      : assets.find((asset) => asset && asset.name === selector);
    process.stdout.write(hit && hit.url ? hit.url : "");
  } catch {
    process.stdout.write("");
  }
});
