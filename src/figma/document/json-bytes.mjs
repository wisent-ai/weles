/**
 * JSON read straight from bytes, and JSON written with the key order it was
 * built in.
 *
 * A Figma document routinely exceeds the longest string V8 can hold, so
 * `JSON.parse(buffer.toString())` cannot read it. This reader walks the
 * buffer itself and only turns single string and number tokens into text,
 * so the document's size is bounded by memory, not by the string limit.
 *
 * The writer takes `Map`s for objects whose key order matters: a plain
 * object moves integer-like keys (a text size `14`, a page named `1`) to the
 * front, while the vocabulary lists them in the order it counted them.
 */

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
/** Bytes that end a bare token: a number or `true`, `false`, `null`. */
const DELIMITERS = new Set([COMMA, CLOSE_BRACE, CLOSE_BRACKET, ...WHITESPACE]);
const LITERALS = new Map([
  ['true', true],
  ['false', false],
  ['null', null],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
]);
/** What makes a number token a float in the document: a point or an exponent. */
const FLOAT_MARKS = /[.eE]/;

/** Parse one JSON document held in `bytes` (a Buffer). */
export function parseJsonBytes(bytes) {
  let at = 0;

  function fail(what) {
    throw new SyntaxError(`${what} at byte ${at} of ${bytes.length}`);
  }

  function skip() {
    while (at < bytes.length && WHITESPACE.has(bytes[at])) at += 1;
  }

  function string() {
    const start = at;
    at += 1;
    let escaped = false;
    while (at < bytes.length && bytes[at] !== QUOTE) {
      if (bytes[at] === BACKSLASH) {
        escaped = true;
        at += 1;
      }
      at += 1;
    }
    if (at >= bytes.length) fail('unterminated string');
    at += 1;
    return escaped
      ? JSON.parse(bytes.toString('utf8', start, at))
      : bytes.toString('utf8', start + 1, at - 1);
  }

  function bare() {
    const start = at;
    while (at < bytes.length && !DELIMITERS.has(bytes[at])) at += 1;
    const token = bytes.toString('latin1', start, at);
    if (LITERALS.has(token)) return LITERALS.get(token);
    const number = Number(token);
    if (token === '' || Number.isNaN(number)) fail(`unexpected token ${JSON.stringify(token)}`);
    // `14.0` in the document is a float, and stays one when written back;
    // a fractional value such as `2.5` reads and writes the same either way.
    if (Number.isInteger(number) && FLOAT_MARKS.test(token)) return new FloatNumber(number);
    return number;
  }

  function value() {
    skip();
    const byte = bytes[at];
    if (byte === OPEN_BRACE) return object();
    if (byte === OPEN_BRACKET) return array();
    if (byte === QUOTE) return string();
    return bare();
  }

  function object() {
    at += 1;
    const result = {};
    skip();
    if (bytes[at] === CLOSE_BRACE) {
      at += 1;
      return result;
    }
    for (;;) {
      skip();
      if (bytes[at] !== QUOTE) fail('expected a key');
      const key = string();
      skip();
      if (bytes[at] !== COLON) fail('expected a colon');
      at += 1;
      // A key such as `__proto__` is data in JSON; assignment would change
      // the object's prototype instead of adding the member.
      Object.defineProperty(result, key, { value: value(), writable: true, enumerable: true, configurable: true });
      skip();
      if (bytes[at] === COMMA) {
        at += 1;
      } else if (bytes[at] === CLOSE_BRACE) {
        at += 1;
        return result;
      } else {
        fail('expected a comma or a closing brace');
      }
    }
  }

  function array() {
    at += 1;
    const result = [];
    skip();
    if (bytes[at] === CLOSE_BRACKET) {
      at += 1;
      return result;
    }
    for (;;) {
      result.push(value());
      skip();
      if (bytes[at] === COMMA) {
        at += 1;
      } else if (bytes[at] === CLOSE_BRACKET) {
        at += 1;
        return result;
      } else {
        fail('expected a comma or a closing bracket');
      }
    }
  }

  const document = value();
  skip();
  if (at !== bytes.length) fail('trailing content');
  return document;
}

/**
 * A whole number written as a float: `6.0`, not `6`. The document writes
 * lengths that way and every vocabulary committed so far keeps them so, so
 * reading and writing again changes no line. It reads as its number
 * (`Number(x)`, arithmetic, comparison) and prints as Python prints a float.
 */
export class FloatNumber {
  constructor(value) {
    this.value = value;
  }

  valueOf() {
    return this.value;
  }

  toString() {
    return Number.isInteger(this.value) ? `${this.value}.0` : String(this.value);
  }
}

/**
 * JSON text for `value`, where a `Map` is written as an object in its own
 * order. `indent` is the number of spaces per level; 0 writes it compact.
 * A field read from a document that did not carry it (`undefined`) is written
 * as `null`, the way the vocabulary has always recorded an absent value.
 */
export function stringifyOrdered(value, indent = 0) {
  function write(item, depth) {
    if (Array.isArray(item)) return list(item.map((entry) => write(entry, depth + 1)), '[', ']', depth);
    if (item instanceof Map) return members([...item.entries()], depth);
    if (item instanceof FloatNumber) return item.toString();
    if (item !== null && typeof item === 'object') return members(Object.entries(item), depth);
    if (item === undefined) return 'null';
    return JSON.stringify(item);
  }

  function members(entries, depth) {
    const separator = indent ? ': ' : ':';
    return list(entries.map(([key, entry]) => `${JSON.stringify(key)}${separator}${write(entry, depth + 1)}`), '{', '}', depth);
  }

  function list(parts, open, close, depth) {
    if (!parts.length) return `${open}${close}`;
    if (!indent) return `${open}${parts.join(',')}${close}`;
    const inner = ' '.repeat(indent * (depth + 1));
    const outer = ' '.repeat(indent * depth);
    return `${open}\n${inner}${parts.join(`,\n${inner}`)}\n${outer}${close}`;
  }

  return write(value, 0);
}
