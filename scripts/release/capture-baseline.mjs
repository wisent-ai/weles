#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { sha256 } from "./lib.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key?.startsWith("--") || value === undefined) {
    throw new Error(`expected --name value, received ${key ?? "<end>"}`);
  }
  args.set(key.slice(2), value);
}

function command(program, commandArgs, options = {}) {
  try {
    return execFileSync(program, commandArgs, {
      cwd: repositoryRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      ...options,
    }).trim();
  } catch {
    return null;
  }
}

async function hashTree(root) {
  const entries = [];
  async function visit(path) {
    const info = await lstat(path);
    const name = relative(root, path);
    if (info.isSymbolicLink()) {
      entries.push([name, "symlink", await realpath(path)]);
      return;
    }
    if (info.isDirectory()) {
      const children = await readdir(path);
      children.sort();
      for (const child of children) await visit(join(path, child));
      return;
    }
    if (info.isFile()) {
      const digest = createHash("sha256").update(await readFile(path)).digest("hex");
      entries.push([name, "file", digest]);
    }
  }
  try {
    await visit(root);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

function browserIdentity(name, configuredPath) {
  if (!configuredPath) return { configured: false };
  const absolutePath = resolve(configuredPath);
  return {
    configured: true,
    path: absolutePath,
    version: command(absolutePath, ["--version"]),
  };
}

const packageManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
const modePath = resolve(args.get("deployment-mode-file") ?? join(process.env.HOME, ".config/weles/deployment-mode"));
let deploymentMode = "legacy-main-poll";
try {
  deploymentMode = (await readFile(modePath, "utf8")).trim();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const gitCommit = command("git", ["rev-parse", "HEAD"]);
const gitStatus = command("git", ["status", "--porcelain=v1", "--untracked-files=no"]);
let rollbackArchive = null;
if (args.has("archive-out")) {
  const archivePath = resolve(args.get("archive-out"));
  await mkdir(dirname(archivePath), { recursive: true, mode: 0o700 });
  execFileSync("tar", [
    "-czf", archivePath,
    "dist",
    "node_modules",
    "package.json",
    "package-lock.json",
    "scripts/worker/deploy",
  ], { cwd: repositoryRoot, stdio: ["ignore", "ignore", "inherit"] });
  rollbackArchive = { path: archivePath, sha256: await sha256(archivePath) };
}
const baseline = {
  schema: "weles.production-baseline.v1",
  capturedAt: new Date().toISOString(),
  repository: {
    name: basename(repositoryRoot),
    commit: gitCommit,
    trackedFilesDirty: Boolean(gitStatus),
  },
  worker: {
    packageVersion: packageManifest.version,
    distSha256: await hashTree(join(repositoryRoot, "dist")),
    nodeVersion: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  deployment: {
    mode: deploymentMode,
    webDeploymentId: args.get("web-deployment-id") ?? null,
    databaseSchemaVersion: args.has("database-schema-version")
      ? Number(args.get("database-schema-version"))
      : null,
  },
  rollbackArchive,
  browsers: {
    chromium: browserIdentity("chromium", args.get("chromium-bin") ?? process.env.WELES_CHROMIUM_BIN),
    firefox: browserIdentity("firefox", args.get("firefox-bin") ?? process.env.WELES_FIREFOX_BIN),
  },
};

const output = `${JSON.stringify(baseline, null, 2)}\n`;
const outputPath = args.get("out");
if (outputPath) {
  await writeFile(resolve(outputPath), output, { mode: 0o600 });
} else {
  process.stdout.write(output);
}
