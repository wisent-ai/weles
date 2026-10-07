/**
 * The values the Figma document walk reads off a node: colours as hex,
 * paints, effects and text settings as the vocabulary records them, and the
 * counting the walk keeps.
 *
 * Rounding is half to even, as the vocabulary has always been written, so a
 * channel of exactly 0.5/255 or a radius of exactly x.xx5 lands where it did
 * in every vocabulary committed before this reader.
 */

import { FloatNumber } from './json-bytes.mjs';

/** The largest value of one 8-bit colour channel. */
const CHANNEL_MAX = 255;
/** Hex digits per channel. */
const HEX_WIDTH = 2;
/** Decimal places kept on an alpha. */
const ALPHA_DIGITS = 3;
/** Decimal places kept on a radius, a spacing or a text size. */
const LENGTH_DIGITS = 2;
/** Where every count the walk keeps starts: nothing seen yet. */
export const NOTHING_COUNTED = 0;

/** `value` rounded to `digits` decimals, halves to the even neighbour. */
export function roundHalfEven(value, digits = 0) {
  const scale = 10 ** digits;
  const scaled = value * scale;
  const floor = Math.floor(scaled);
  if (scaled - floor !== 0.5) return Math.round(scaled) / scale;
  return (floor % 2 === 0 ? floor : floor + 1) / scale;
}

/** A number as Python prints a float: `1.0`, not `1`. */
export function floatText(value) {
  return new FloatNumber(value).toString();
}

/** 14, not 14.0, so a size reads as the designer typed it. */
export function plainNumber(value) {
  return String(Number(value));
}

/** The items of a field that holds a list, and none when it holds anything else. */
export function items(value) {
  return Array.isArray(value) ? value : [];
}

/** A JSON object; a whole number read as a float is a number, not an object. */
export function isRecord(item) {
  return (
    item !== null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    !(item instanceof FloatNumber)
  );
}

function channelHex(value) {
  const channel = Math.max(
    0,
    Math.min(CHANNEL_MAX, roundHalfEven(Number(value) * CHANNEL_MAX)),
  );
  return channel.toString(16).padStart(HEX_WIDTH, '0');
}

/** A Figma colour, whose r, g and b the REST file always carries, as hex. */
export function hexOf(color) {
  return `#${channelHex(color.r)}${channelHex(color.g)}${channelHex(color.b)}`;
}

export function visible(item) {
  return isRecord(item) && item.visible !== false;
}

export function alphaOf(color) {
  return roundHalfEven(Number(color.a), ALPHA_DIGITS);
}

export function typeOf(item) {
  return typeof item.type === 'string' ? item.type : '';
}

/** The value a fill or stroke paints: a hex for a solid, stops for a gradient. */
export function paintValue(paint) {
  const kind = typeOf(paint);
  if (kind === 'SOLID' && isRecord(paint.color)) return hexOf(paint.color);
  if (kind.startsWith('GRADIENT')) {
    return {
      type: kind,
      stops: items(paint.gradientStops)
        .filter((stop) => isRecord(stop.color))
        .map((stop) => hexOf(stop.color)),
    };
  }
  return null;
}

/** An effect as the vocabulary records it; an absent radius is written as null. */
export function effectValue(effect) {
  const value = { type: typeOf(effect), radius: effect.radius };
  if (isRecord(effect.color)) {
    value.color = hexOf(effect.color);
    value.alpha = new FloatNumber(alphaOf(effect.color));
  }
  if (isRecord(effect.offset))
    value.offset = [effect.offset.x, effect.offset.y];
  if (effect.spread !== undefined && effect.spread !== null)
    value.spread = effect.spread;
  return value;
}

/** The text settings of a Figma text style the vocabulary keeps, set ones only. */
export function textValue(style) {
  const { fontFamily, fontWeight, fontSize, lineHeightPx, letterSpacing } =
    style;
  const kept = {
    fontFamily,
    fontWeight,
    fontSize,
    lineHeightPx,
    letterSpacing,
  };
  return Object.fromEntries(
    Object.entries(kept).filter(
      ([, setting]) => setting !== undefined && setting !== null,
    ),
  );
}

/**
 * A length rounded to hundredths, or null when it is not a number or is not
 * positive.
 */
export function radiusOf(value) {
  const numeric =
    typeof value === 'number' ||
    value instanceof FloatNumber ||
    (typeof value === 'string' && value.trim() !== '');
  if (!numeric) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const rounded = roundHalfEven(number, LENGTH_DIGITS);
  return rounded > 0 ? rounded : null;
}

/** Add one to `key` in a counting map. */
export function count(counter, key) {
  counter.set(key, counter.has(key) ? counter.get(key) + 1 : 1);
}

/**
 * The counting map ordered by count, most first; equal counts keep the order
 * they were first counted in.
 */
export function mostCommon(counter) {
  return new Map(
    [...counter.entries()].sort((left, right) => right[1] - left[1]),
  );
}

/** The counting map ordered by its keys read as numbers. */
export function byNumericKey(counter) {
  return new Map(
    [...counter.entries()].sort(
      (left, right) => Number(left[0]) - Number(right[0]),
    ),
  );
}
