#!/usr/bin/env node
/**
 * Walk a Figma document file and write its summary, node list and vocabulary.
 *
 *     node parse-figma-document.mjs <document.json[.gz]> <summary.json> <nodes.json> [<vocabulary.json>]
 *
 * `src/figma/export-design-assets.mjs` calls it at export time, and
 * `wisent-components` runs it once more over a committed `document.json.gz`
 * whose export predates the vocabulary. A Figma file routinely exceeds the
 * longest string Node can hold, so the document is read from its bytes
 * (`json-bytes.mjs`) and never becomes one string.
 *
 * The vocabulary is what the designer defined, resolved to values, and
 * nothing a regex over the raw file could tell apart from a pasted
 * screenshot: every colour variable bound to a fill or stroke (the REST file
 * carries only the alias, so the value is read off the paint it is bound
 * to), every named style with the value of the first node that uses it, the
 * font families set on text, the corner radii drawn, and per page the count
 * of every gradient paint and blur or shadow effect. Fills drawn without a
 * variable are counted apart, so a reader can tell a palette colour from a
 * one-off.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

import { byNumericKey, isRecord, mostCommon } from './figma-values.mjs';
import { walkDocument } from './figma-walk.mjs';
import { FloatNumber, parseJsonBytes, stringifyOrdered } from './json-bytes.mjs';

/** The vocabulary file's format; a reader refuses one it does not know. */
const SCHEMA_VERSION = 1;
/** Spaces per level in the vocabulary, which is committed and read by people. */
const VOCABULARY_INDENT = 2;
/** The arguments before the optional vocabulary path. */
const REQUIRED_ARGUMENTS = 3;
/** The exit status of a call without its required paths. */
const USAGE_EXIT = 2;

function sizeOf(value) {
  if (!isRecord(value)) return 0;
  return Object.keys(value).length;
}

function textOf(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function summaryOf(payload, walk) {
  return {
    version: textOf(payload.version),
    lastModified: payload.lastModified,
    components: sizeOf(payload.components),
    componentSets: sizeOf(payload.componentSets),
    styles: sizeOf(payload.styles),
    imageRefs: [...walk.imageRefs].sort(),
    exportNodes: walk.exportNodes,
    topLevelNodes: walk.topLevelNodes,
  };
}

function variablesOf(walk) {
  const ordered = [...walk.variables.entries()].sort((left, right) => right[1].uses - left[1].uses);
  return new Map(
    ordered.map(([id, variable]) => {
      const hexes = mostCommon(variable.hexes);
      return [id, { hex: hexes.keys().next().value, hexes, uses: variable.uses, pages: mostCommon(variable.pages) }];
    }),
  );
}

function stylesOf(payload, walk) {
  const styles = new Map();
  if (!isRecord(payload.styles)) return styles;
  for (const [id, meta] of Object.entries(payload.styles)) {
    if (!isRecord(meta)) continue;
    styles.set(id, {
      name: textOf(meta.name),
      styleType: textOf(meta.styleType),
      remote: Boolean(meta.remote),
      value: walk.styleExamples.get(id),
    });
  }
  return styles;
}

function pagesOf(walk) {
  const pages = new Map();
  for (const [page, stats] of walk.byPage) {
    if (!page) continue;
    pages.set(page, {
      radii: [...stats.radii].sort((left, right) => left - right).map((radius) => new FloatNumber(radius)),
      pills: stats.pills,
      paints: mostCommon(stats.paints),
      effects: mostCommon(stats.effects),
      unboundFills: mostCommon(stats.unboundFills),
    });
  }
  return pages;
}

function vocabularyOf(payload, walk) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name: payload.name,
    version: textOf(payload.version),
    lastModified: payload.lastModified,
    pages: walk.pages,
    variables: variablesOf(walk),
    styles: stylesOf(payload, walk),
    fonts: mostCommon(walk.fonts),
    textSizes: byNumericKey(walk.textSizes),
    textSettings: mostCommon(walk.textSettings),
    spacings: byNumericKey(walk.spacings),
    shadows: mostCommon(walk.shadows),
    gradientStops: mostCommon(walk.gradientStops),
    byPage: pagesOf(walk),
  };
}

function main(argv) {
  if (argv.length < REQUIRED_ARGUMENTS) {
    process.stderr.write('usage: parse-figma-document.mjs <document.json[.gz]> <summary.json> <nodes.json> [<vocabulary.json>]\n');
    process.exit(USAGE_EXIT);
  }
  const [source, summaryPath, nodesPath, vocabularyPath] = argv;
  const raw = readFileSync(source);
  const payload = parseJsonBytes(source.endsWith('.gz') ? gunzipSync(raw) : raw);
  const walk = walkDocument(payload);
  writeFileSync(summaryPath, stringifyOrdered(summaryOf(payload, walk)));
  writeFileSync(nodesPath, stringifyOrdered(walk.nodes));
  if (vocabularyPath) {
    writeFileSync(vocabularyPath, `${stringifyOrdered(vocabularyOf(payload, walk), VOCABULARY_INDENT)}\n`);
  }
}

main(process.argv.slice(2));
