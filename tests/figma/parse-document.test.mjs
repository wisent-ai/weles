/**
 * What parse-figma-document.py writes for a Figma document.
 *
 * The exporter parses every document once, in Python, because a Figma file
 * exceeds the string Node can hold. That one parse is where the design
 * vocabulary is read: the colour variables bound to visible fills and
 * strokes resolved to their values, the named styles resolved from the first
 * node that uses them, the fonts, the radii, and the gradients and blurs per
 * page. Hidden layers stay in the node index and out of the vocabulary: the
 * Untitled UI kit the pages were started from leaves its purple variables on
 * hidden variant layers inside every instance, and a lint that admitted them
 * would admit the kit.
 *
 * Run: node --test tests/figma/parse-document.test.mjs
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const REPO = resolve(import.meta.dirname, '..', '..');
const PARSER = join(REPO, 'src/figma/parse-figma-document.py');
const WORK = join(REPO, 'build', `figma-parse-${process.pid}-${randomUUID().slice(0, 8)}`);

const brand = { r: 0.4627451, g: 0.6, b: 0.4705882, a: 1 };
const purple = { r: 0.4115, g: 0.2542, b: 0.7772, a: 1 };
const white = { r: 1, g: 1, b: 1, a: 1 };

const BRAND_VARIABLE = 'VariableID:1dd758d8ad4e95ce13f0de3bf2e7cfc28d454aa1/104:149';
const PURPLE_VARIABLE = 'VariableID:f4a315e8966c00e122db404511a90fdfca954d15/8790:770';

/** A document shaped like the REST file endpoint's, small enough to read. */
function document() {
  return {
    name: 'Wisent Web',
    version: '2330950954272231285',
    lastModified: '2026-03-15T00:05:55Z',
    styles: {
      '27:88': { key: 'k1', name: 'HubotSans/Text smMedium', styleType: 'TEXT', remote: true, description: '' },
      '31:1': { key: 'k2', name: 'Gray (light mode)/900', styleType: 'FILL', remote: false, description: '' },
    },
    document: {
      id: '0:0',
      name: 'Document',
      type: 'DOCUMENT',
      children: [
        {
          id: '1:1',
          name: 'Landing',
          type: 'CANVAS',
          children: [
            {
              id: '2:1',
              name: 'Hero',
              type: 'FRAME',
              cornerRadius: 12,
              boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: BRAND_VARIABLE }] },
              fills: [{ blendMode: 'NORMAL', type: 'SOLID', color: brand }],
              strokes: [
                {
                  blendMode: 'NORMAL',
                  type: 'GRADIENT_LINEAR',
                  gradientStops: [{ color: white, position: 0 }, { color: brand, position: 1 }],
                },
              ],
              layoutMode: 'VERTICAL',
              paddingTop: 16,
              paddingRight: 24,
              paddingBottom: 16,
              paddingLeft: 24,
              itemSpacing: 8,
              effects: [
                { type: 'BACKGROUND_BLUR', visible: true, radius: 9 },
                { type: 'DROP_SHADOW', visible: true, radius: 12, spread: 0, offset: { x: 0, y: 4 }, color: { r: 0.04, g: 0.05, b: 0.07, a: 0.04 } },
                { type: 'DROP_SHADOW', visible: false, radius: 30, spread: 0, offset: { x: 0, y: 12 }, color: { r: 0, g: 0, b: 0, a: 0.2 } },
              ],
              children: [
                {
                  id: '2:2',
                  name: 'Title',
                  type: 'TEXT',
                  style: { fontFamily: 'Hubot Sans', fontWeight: 500, fontSize: 14, lineHeightPx: 20, letterSpacing: 0 },
                  styles: { text: '27:88' },
                  fills: [{ blendMode: 'NORMAL', type: 'SOLID', color: white, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: BRAND_VARIABLE } } }],
                },
                {
                  id: '2:3',
                  name: 'Pill',
                  type: 'RECTANGLE',
                  rectangleCornerRadii: [9999, 9999, 50, 50],
                  fills: [{ blendMode: 'NORMAL', type: 'SOLID', color: purple }],
                  styles: { fill: '31:1' },
                },
                {
                  id: '2:4',
                  name: 'Kit variant',
                  type: 'FRAME',
                  visible: false,
                  boundVariables: { fills: [{ type: 'VARIABLE_ALIAS', id: PURPLE_VARIABLE }] },
                  fills: [{ blendMode: 'NORMAL', type: 'SOLID', color: purple }],
                  effects: [{ type: 'BACKGROUND_BLUR', visible: true, radius: 4 }],
                  children: [
                    {
                      id: '2:5',
                      name: 'Nested',
                      type: 'RECTANGLE',
                      fills: [{ blendMode: 'NORMAL', type: 'IMAGE', imageRef: 'hidden-image' }],
                    },
                    {
                      id: '2:6',
                      name: 'Kit label',
                      type: 'TEXT',
                      style: { fontFamily: 'Inter', fontWeight: 600, fontSize: 13, lineHeightPx: 18, letterSpacing: 0 },
                      fills: [{ blendMode: 'NORMAL', type: 'SOLID', color: purple }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: '3:1',
          name: 'Archive',
          type: 'CANVAS',
          children: [
            {
              id: '3:2',
              name: 'Old',
              type: 'FRAME',
              exportSettings: [{ format: 'PNG' }],
              fills: [{ blendMode: 'NORMAL', type: 'IMAGE', imageRef: 'shown-image' }],
            },
          ],
        },
      ],
    },
  };
}

function parse(sourceName, bytes) {
  const source = join(WORK, sourceName);
  writeFileSync(source, bytes);
  const summary = join(WORK, `${sourceName}.summary.json`);
  const nodes = join(WORK, `${sourceName}.nodes.json`);
  const vocabulary = join(WORK, `${sourceName}.vocabulary.json`);
  const result = spawnSync('python3', [PARSER, source, summary, nodes, vocabulary], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return {
    summary: JSON.parse(readFileSync(summary, 'utf8')),
    nodes: JSON.parse(readFileSync(nodes, 'utf8')),
    vocabulary: JSON.parse(readFileSync(vocabulary, 'utf8')),
  };
}

before(() => {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
});

after(() => {
  rmSync(WORK, { recursive: true, force: true });
});

test('a visible variable is resolved to its value with its uses per page; a hidden one is left out', () => {
  const { vocabulary } = parse('document.json', JSON.stringify(document()));
  const variables = vocabulary.variables;
  assert.deepEqual(Object.keys(variables), [BRAND_VARIABLE]);
  // Two bindings: the frame's node-level alias and the title's paint-level one,
  // whose paint is white while the variable's value is the brand green.
  assert.equal(variables[BRAND_VARIABLE].hex, '#769978');
  assert.deepEqual(variables[BRAND_VARIABLE].hexes, { '#769978': 1, '#ffffff': 1 });
  assert.equal(variables[BRAND_VARIABLE].uses, 2);
  assert.deepEqual(variables[BRAND_VARIABLE].pages, { Landing: 2 });
});

test('gradients, blurs, radii, pills and unbound fills are counted per page, on visible layers only', () => {
  const { vocabulary } = parse('counts.json', JSON.stringify(document()));
  assert.deepEqual(vocabulary.pages, ['Landing', 'Archive']);
  const landing = vocabulary.byPage.Landing;
  assert.deepEqual(landing.paints, { GRADIENT_LINEAR: 1 });
  assert.deepEqual(landing.effects, { BACKGROUND_BLUR: 1, DROP_SHADOW: 1 });
  assert.deepEqual(landing.radii, [12, 50]);
  assert.equal(landing.pills, 2);
  assert.deepEqual(landing.unboundFills, { '#6941c6': 1 });
  assert.deepEqual(vocabulary.byPage.Archive.paints, {});
  // The text set is what is shown: the kit's Inter 13 px on the hidden
  // variant is in neither the fonts, the sizes nor the settings.
  assert.deepEqual(vocabulary.fonts, { 'Hubot Sans': 1 });
  assert.deepEqual(vocabulary.textSizes, { 14: 1 });
  assert.deepEqual(vocabulary.textSettings, { 'Hubot Sans|14|20|500': 1 });
  // The Hero frame's paddings and gap, and its one visible shadow as CSS
  // would write it; the hidden shadow and the blur are not shadows.
  assert.deepEqual(vocabulary.spacings, { 8: 1, 16: 2, 24: 2 });
  assert.deepEqual(vocabulary.shadows, { 'drop|0|4|12|0|#0a0d12|0.04': 1 });
  // The Hero's gradient stroke runs white to brand: both are drawn colours.
  assert.deepEqual(vocabulary.gradientStops, { '#ffffff': 1, '#769978': 1 });
});

test('a named style is resolved from the first node that uses it', () => {
  const { vocabulary, summary } = parse('styles.json', JSON.stringify(document()));
  assert.equal(summary.styles, 2);
  assert.deepEqual(vocabulary.styles['27:88'], {
    name: 'HubotSans/Text smMedium',
    styleType: 'TEXT',
    remote: true,
    value: { fontFamily: 'Hubot Sans', fontWeight: 500, fontSize: 14, lineHeightPx: 20, letterSpacing: 0 },
  });
  assert.deepEqual(vocabulary.styles['31:1'], { name: 'Gray (light mode)/900', styleType: 'FILL', remote: false, value: '#6941c6' });
});

test('the node index and the summary keep every node, hidden or not, and a gzipped document reads the same', () => {
  const plain = parse('plain.json', JSON.stringify(document()));
  const zipped = parse('zipped.json.gz', gzipSync(JSON.stringify(document())));
  assert.deepEqual(plain.nodes.map((node) => node.id), ['0:0', '1:1', '2:1', '2:2', '2:3', '2:4', '2:5', '2:6', '3:1', '3:2']);
  assert.deepEqual(plain.summary.imageRefs, ['hidden-image', 'shown-image']);
  assert.deepEqual(plain.summary.exportNodes, [{ id: '3:2', name: 'Old', settings: [{ format: 'PNG' }] }]);
  assert.deepEqual(plain.summary.topLevelNodes, [
    { id: '2:1', name: 'Hero', page: 'Landing' },
    { id: '3:2', name: 'Old', page: 'Archive' },
  ]);
  assert.deepEqual(zipped.vocabulary, plain.vocabulary);
  assert.deepEqual(zipped.nodes, plain.nodes);
});
