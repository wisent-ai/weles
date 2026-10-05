// Link every ES module under the given roots without running any of them, and
// fail when one imports a name its dependency does not export.
//
// A trajectory is loaded only when a sign-in runs, so an import of a name the
// committed dependency never exported is found by the first browser that needs
// it — on the worker, as `SyntaxError: The requested module … does not provide
// an export named …`, after the release shipped. Linking is the step that
// raises that error and evaluation is not needed for it, so no `.mjs` module
// runs here. Everything else — the compiled CommonJS under dist, packages and
// node: builtins — is imported as Node itself would resolve it from the
// importing file, for its export names.
//
// Usage: node --experimental-vm-modules --experimental-import-meta-resolve \
//          release/checks/module-links.mjs <root>...
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error('module-links: name at least one directory of modules to link');
  process.exit(2);
}

function modulesUnder(root) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) found.push(...modulesUnder(path));
    else if (entry.name.endsWith('.mjs')) found.push(resolve(path));
  }
  return found;
}

const context = vm.createContext({});
const externals = new Map();

async function external(url) {
  if (!externals.has(url)) {
    const namespace = await import(url);
    const names = Object.keys(namespace);
    externals.set(url, { names, namespace });
  }
  const { names, namespace } = externals.get(url);
  return new vm.SyntheticModule(names, function init() {
    for (const name of names) this.setExport(name, namespace[name]);
  }, { context, identifier: url });
}

// One graph per module checked, so a refusal deep in a shared dependency is
// reported against every module that reaches it rather than leaving the
// shared module half-linked for the next one.
async function link(path) {
  const graph = new Map();
  const sourceModule = (url) => {
    if (!graph.has(url)) {
      graph.set(url, new vm.SourceTextModule(readFileSync(fileURLToPath(url), 'utf8'), {
        context,
        identifier: url,
      }));
    }
    return graph.get(url);
  };
  const linker = async (specifier, referencing) => {
    const url = import.meta.resolve(specifier, referencing.identifier);
    if (url.startsWith('file:') && url.endsWith('.mjs')) return sourceModule(url);
    const key = `external:${url}`;
    if (!graph.has(key)) graph.set(key, await external(url));
    return graph.get(key);
  };
  await sourceModule(pathToFileURL(path).href).link(linker);
}

const failures = [];
let linked = 0;
for (const root of roots) {
  for (const path of modulesUnder(root)) {
    try {
      await link(path);
      linked += 1;
    } catch (error) {
      failures.push(`${path}: ${error?.message ?? error}`);
    }
  }
}
for (const failure of failures) console.error(`module-links: ${failure}`);
console.log(`module-links: ${linked} module(s) linked, ${failures.length} refused`);
process.exit(failures.length ? 1 : 0);
