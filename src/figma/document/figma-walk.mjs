/**
 * One walk over a Figma document: the node index, the export summary's
 * lists, and what the design vocabulary counts on visible layers.
 *
 * A hidden layer and everything under it stays in the node index, which is
 * an index of the file, and out of the vocabulary, which is what the design
 * shows: the Untitled UI kit the pages were started from leaves its purple
 * variables on hidden variant layers inside every instance.
 */
import {
  NOTHING_COUNTED,
  alphaOf,
  count,
  floatText,
  hexOf,
  isRecord,
  items,
  plainNumber,
  radiusOf,
  typeOf,
  visible,
} from './figma-values.mjs';
import { keyPart, readStyles, readText } from './walk/layer-text.mjs';

/**
 * A node's paint lists by the field Figma keeps each in, which is also the
 * key its bound variables are kept under; every list is read the same way.
 */
function paintLists(node) {
  return { fills: node.fills, strokes: node.strokes };
}
/** The frame layouts whose paddings and gaps are spacings. */
const AUTO_LAYOUTS = { HORIZONTAL: true, VERTICAL: true };
/** The effect types that are shadows, and how CSS names each. */
const SHADOW_KINDS = { DROP_SHADOW: 'drop', INNER_SHADOW: 'inset' };

function newPage() {
  return {
    radii: new Set(),
    pills: NOTHING_COUNTED,
    paints: new Map(),
    effects: new Map(),
    unboundFills: new Map(),
  };
}

function newVariable() {
  return { hexes: new Map(), uses: NOTHING_COUNTED, pages: new Map() };
}

function entry(map, key, create) {
  if (!map.has(key)) map.set(key, create());
  return map.get(key);
}

function imageRef(paint, found) {
  if (
    isRecord(paint) &&
    paint.type === 'IMAGE' &&
    typeof paint.imageRef === 'string'
  )
    found.add(paint.imageRef);
}

/** Walk `payload` (a parsed REST file) and return everything the outputs need. */
export function walkDocument(payload) {
  const walk = {
    nodes: [],
    imageRefs: new Set(),
    exportNodes: [],
    topLevelNodes: [],
    pages: [],
    variables: new Map(),
    styleExamples: new Map(),
    textSizes: new Map(),
    textSettings: new Map(),
    spacings: new Map(),
    shadows: new Map(),
    gradientStops: new Map(),
    fonts: new Map(),
    byPage: new Map(),
  };
  const stack = [[payload.document, '', true]];
  while (stack.length) {
    let [node, page, shown] = stack.pop();
    if (!isRecord(node)) continue;
    walk.nodes.push({
      id: node.id,
      name: keyPart(node.name),
      type: keyPart(node.type),
    });
    if (node.type === 'CANVAS') {
      page = keyPart(node.name);
      walk.pages.push(page);
      for (const child of items(node.children)) {
        walk.topLevelNodes.push({
          id: child.id,
          name: keyPart(child.name),
          page,
        });
      }
    }
    shown = shown && node.visible !== false;
    if (Array.isArray(node.exportSettings) && node.exportSettings.length) {
      walk.exportNodes.push({
        id: node.id,
        name: keyPart(node.name),
        settings: node.exportSettings,
      });
    }
    // Children go on the stack last-first, so they come off in document order.
    for (const child of [...items(node.children)].reverse())
      stack.push([child, page, shown]);
    if (!shown) {
      for (const paints of Object.values(paintLists(node)))
        for (const paint of items(paints)) imageRef(paint, walk.imageRefs);
      continue;
    }
    readShownNode(node, page, walk);
  }
  return walk;
}

/** The auto-layout lengths a stylesheet's padding and gap may take. */
function spacingsOf(node) {
  const {
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft,
    itemSpacing,
    counterAxisSpacing,
  } = node;
  return [
    paddingTop,
    paddingRight,
    paddingBottom,
    paddingLeft,
    itemSpacing,
    counterAxisSpacing,
  ];
}

/**
 * Whether `radius` rounds the layer's shorter side fully. Figma clamps a
 * corner at half that side, so a radius reaching it draws a pill whatever
 * number the designer typed; it is not a length on the radius scale. A layer
 * the file gives no box for cannot be told apart, and its radius is kept.
 */
function roundsFully(node, radius) {
  const box = node.absoluteBoundingBox;
  if (!isRecord(box)) return false;
  const { width, height } = box;
  if (typeof width !== 'number' || typeof height !== 'number') return false;
  return radius + radius >= Math.min(width, height);
}

function readShownNode(node, page, walk) {
  const stats = entry(walk.byPage, page, newPage);
  readPaints(node, page, stats, walk);
  readEffects(node, stats, walk);
  if (Object.hasOwn(AUTO_LAYOUTS, node.layoutMode)) {
    for (const value of spacingsOf(node)) {
      const length = radiusOf(value);
      if (length !== null) count(walk.spacings, plainNumber(length));
    }
  }
  for (const value of [
    node.cornerRadius,
    ...items(node.rectangleCornerRadii),
  ]) {
    const radius = radiusOf(value);
    if (radius === null) continue;
    if (roundsFully(node, radius)) stats.pills++;
    else stats.radii.add(radius);
  }
  readText(node, walk);
  readStyles(node, walk);
}

/** The variable a solid paint is bound to: on the paint, or at its index on the node. */
function aliasOf(paint, aliases, index) {
  if (isRecord(paint.boundVariables) && isRecord(paint.boundVariables.color))
    return paint.boundVariables.color;
  if (index < aliases.length && isRecord(aliases[index])) return aliases[index];
  return null;
}

function readPaints(node, page, stats, walk) {
  const bound = isRecord(node.boundVariables) ? node.boundVariables : {};
  for (const [kind, paints] of Object.entries(paintLists(node))) {
    const aliases = items(bound[kind]);
    items(paints).forEach((paint, index) => {
      if (!isRecord(paint)) return;
      const paintType = typeOf(paint);
      imageRef(paint, walk.imageRefs);
      if (!visible(paint)) return;
      if (paintType.startsWith('GRADIENT')) {
        count(stats.paints, paintType);
        // The colours a gradient runs through are drawn as surely as a
        // solid fill: the glass buttons' strokes are #f2f2f2 to #818181 to
        // white, and no variable names them.
        for (const stop of items(paint.gradientStops)) {
          if (isRecord(stop) && isRecord(stop.color))
            count(walk.gradientStops, hexOf(stop.color));
        }
      }
      if (paintType !== 'SOLID' || !isRecord(paint.color)) return;
      const colour = hexOf(paint.color);
      const alias = aliasOf(paint, aliases, index);
      if (
        isRecord(alias) &&
        alias.type === 'VARIABLE_ALIAS' &&
        typeof alias.id === 'string'
      ) {
        const variable = entry(walk.variables, alias.id, newVariable);
        count(variable.hexes, colour);
        variable.uses++;
        count(variable.pages, page);
      } else {
        count(stats.unboundFills, colour);
      }
    });
  }
}

/** A length of a shadow as its key writes it: a field Figma leaves out is 0. */
function shadowLength(value) {
  if (value === undefined || value === null) return String(NOTHING_COUNTED);
  return plainNumber(value);
}

function readEffects(node, stats, walk) {
  for (const effect of items(node.effects)) {
    if (!visible(effect) || typeof effect.type !== 'string') continue;
    count(stats.effects, effect.type);
    // A shadow as CSS would write it, so a token can be held to one the
    // designer drew: x y blur spread colour alpha.
    if (Object.hasOwn(SHADOW_KINDS, effect.type) && isRecord(effect.color)) {
      const offset = isRecord(effect.offset) ? effect.offset : {};
      const key = [
        SHADOW_KINDS[effect.type],
        shadowLength(offset.x),
        shadowLength(offset.y),
        shadowLength(effect.radius),
        shadowLength(effect.spread),
        hexOf(effect.color),
        floatText(alphaOf(effect.color)),
      ].join('|');
      count(walk.shadows, key);
    }
  }
}
