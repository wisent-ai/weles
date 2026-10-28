/**
 * What a visible layer's text and its named styles add to a document walk
 * (`../figma-walk.mjs`): the fonts, sizes and text settings the designer
 * typed, and one example value for each style the file names.
 */
import {
  count,
  effectValue,
  isRecord,
  items,
  paintValue,
  plainNumber,
  radiusOf,
  textValue,
  visible,
} from '../figma-values.mjs';

/** A field as text in a key or a name, and nothing when the node leaves it out. */
export function keyPart(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

/** A rounded length as text in a key, and nothing when there is none. */
function lengthPart(length) {
  if (length === null) return '';
  return plainNumber(length);
}

/** Count the font, size and text setting a visible text layer carries. */
export function readText(node, walk) {
  const style = node.style;
  if (node.type !== 'TEXT' || !isRecord(style) || !style.fontFamily) return;
  count(walk.fonts, style.fontFamily);
  // The text set on visible layers: which sizes, line heights and weights
  // the designer typed, so a stylesheet's size can be told from a scale the
  // library names and a size no page carries.
  const size = radiusOf(style.fontSize);
  if (size === null) return;
  count(walk.textSizes, plainNumber(size));
  const height = lengthPart(radiusOf(style.lineHeightPx));
  count(
    walk.textSettings,
    [
      style.fontFamily,
      plainNumber(size),
      height,
      keyPart(style.fontWeight),
    ].join('|'),
  );
}

/**
 * Keep the first example value of each named style the layer applies: the
 * one paint itself when the style paints one, else the list of its paints.
 */
export function readStyles(node, walk) {
  if (!isRecord(node.styles)) return;
  for (const [kind, styleId] of Object.entries(node.styles)) {
    if (typeof styleId !== 'string' || walk.styleExamples.has(styleId))
      continue;
    if (kind.startsWith('fill') || kind.startsWith('stroke')) {
      const paints = items(
        kind.startsWith('fill') ? node.fills : node.strokes,
      ).filter(visible);
      const values = paints.map(paintValue).filter((value) => value !== null);
      const [only, ...more] = values;
      if (values.length)
        walk.styleExamples.set(styleId, more.length ? values : only);
    } else if (kind === 'text' && isRecord(node.style)) {
      walk.styleExamples.set(styleId, textValue(node.style));
    } else if (kind === 'effect') {
      walk.styleExamples.set(
        styleId,
        items(node.effects).filter(visible).map(effectValue),
      );
    }
  }
}
