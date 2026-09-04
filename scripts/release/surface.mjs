#!/usr/bin/env node

import ts from 'typescript';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
if (!configPath) throw new Error('tsconfig.json not found');
const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root, { allowJs: true });
const program = ts.createProgram({
  rootNames: [
    ...parsed.fileNames,
    join(root, 'scripts/worker/weles-api-server.mjs'),
  ],
  options: { ...parsed.options, allowJs: true, checkJs: false, noEmit: true },
});
const checker = program.getTypeChecker();
const surface = new Set();

const indexSource = program.getSourceFile(join(root, 'src/index.ts'));
if (!indexSource) throw new Error('src/index.ts was not parsed');
const indexSymbol = checker.getSymbolAtLocation(indexSource);
if (!indexSymbol) throw new Error('src/index.ts has no module symbol');
for (const symbol of checker.getExportsOfModule(indexSymbol)) {
  surface.add(`export:${symbol.getName()}`);
}

const packageManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
if (!packageManifest.bin || typeof packageManifest.bin !== 'object') throw new Error('package.json bin map is missing');
for (const command of Object.keys(packageManifest.bin)) surface.add(`cmd:${command}`);

const cliSource = program.getSourceFile(join(root, 'src/cli.ts'));
if (!cliSource) throw new Error('src/cli.ts was not parsed');
let cliCommands = 0;
for (const node of cliSource.statements) {
  if (!ts.isTypeAliasDeclaration(node) || node.name.text !== 'CliCommand' || !ts.isUnionTypeNode(node.type)) continue;
  for (const member of node.type.types) {
    if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
      throw new Error('CliCommand contains a non-string member');
    }
    surface.add(`cmd:weles ${member.literal.text}`);
    cliCommands += 1;
  }
}
if (!cliCommands) throw new Error('no Weles CLI commands resolved');

const mcpSource = program.getSourceFile(join(root, 'src/mcp.ts'));
if (!mcpSource) throw new Error('src/mcp.ts was not parsed');
let mcpTools = 0;
function collectMcpTools(node) {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'welesMcpTools' && node.initializer && ts.isArrayLiteralExpression(node.initializer)) {
    for (const element of node.initializer.elements) {
      if (!ts.isObjectLiteralExpression(element)) throw new Error('welesMcpTools contains a non-object member');
      const name = element.properties.find((property) => ts.isPropertyAssignment(property) && property.name?.getText(mcpSource) === 'name');
      if (!name || !ts.isPropertyAssignment(name) || !ts.isStringLiteral(name.initializer)) {
        throw new Error('MCP tool has no static string name');
      }
      surface.add(`mcp:${name.initializer.text}`);
      mcpTools += 1;
    }
  }
  ts.forEachChild(node, collectMcpTools);
}
collectMcpTools(mcpSource);
if (!mcpTools) throw new Error('no Weles MCP tools resolved');

const apiSource = program.getSourceFile(join(root, 'scripts/worker/weles-api-server.mjs'));
if (!apiSource) throw new Error('worker API server was not parsed');
let routes = 0;
function collectRoutes(node) {
  if (ts.isStringLiteral(node) && /^(GET|POST|PATCH|DELETE) \/[A-Za-z]/.test(node.text)) {
    surface.add(`http:${node.text}`);
    routes += 1;
  }
  ts.forEachChild(node, collectRoutes);
}
collectRoutes(apiSource);
if (!routes) throw new Error('no worker HTTP routes resolved');

const compatibility = JSON.parse(await readFile(join(root, 'release/compatibility-policy.json'), 'utf8'));
if (!Array.isArray(compatibility.api?.supportedSchemas) || !compatibility.api.supportedSchemas.length) {
  throw new Error('release compatibility policy has no API schemas');
}
for (const schema of compatibility.api.supportedSchemas) surface.add(`schema:${schema}`);
for (const status of ['queued', 'leased', 'running', 'succeeded', 'failed', 'cancelled']) {
  surface.add(`task-status:${status}`);
}

const versionChange = JSON.parse(await readFile(join(root, 'release/version-change.json'), 'utf8'));
if (typeof versionChange.current !== 'string' || !versionChange.current) {
  throw new Error('release version-change declaration has no current version');
}
process.stdout.write(`${JSON.stringify({
  surface: [...surface].sort(),
  version: versionChange.current,
}, null, 2)}\n`);
