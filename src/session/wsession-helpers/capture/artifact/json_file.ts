// Writes one instrumentation artifact as JSON without ever holding the whole
// document as one string. A long run's dump outgrows the largest string V8
// can build ('Invalid string length'), so a value is serialised whole only
// when that fits; a value that does not is written member by member, and a
// single string too long to escape at once is written in slices. The bytes
// match JSON.stringify of the same value with lone UTF-16 surrogates replaced
// by U+FFFD.

import { closeSync, openSync, writeSync } from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';

// JSON escapes one UTF-16 unit into at most six characters (\uXXXX), so a
// slice of this many units always escapes to a string V8 can hold.
const STRING_SLICE = Math.floor(bufferConstants.MAX_STRING_LENGTH / 6);
const SURROGATE = /[\uD800-\uDFFF]/g;

/** JSON.stringify's view of a member: its toJSON result when it has one. */
function prepared(key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    'toJSON' in value &&
    typeof value.toJSON === 'function'
  ) {
    return value.toJSON(key);
  }
  return value;
}

function writeString(fd: number, text: string): void {
  writeSync(fd, '"');
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + STRING_SLICE, text.length);
    // Never cut a surrogate pair: its halves would each read as a lone surrogate.
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    writeSync(
      fd,
      JSON.stringify(text.slice(start, end).replace(SURROGATE, '\uFFFD')).slice(
        1,
        -1,
      ),
    );
    start = end;
  }
  writeSync(fd, '"');
}

function writeValue(
  fd: number,
  key: string,
  raw: unknown,
  inArray: boolean,
  stack: Set<object>,
): void {
  const value = prepared(key, raw);
  let whole: string | undefined;
  try {
    whole = JSON.stringify(value, (_k, v: unknown) =>
      typeof v === 'string' ? v.replace(SURROGATE, '\uFFFD') : v,
    );
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  if (whole !== undefined) {
    writeSync(fd, whole);
    return;
  }
  if (
    value === undefined ||
    typeof value === 'function' ||
    typeof value === 'symbol'
  ) {
    // Only reached inside an array: JSON.stringify writes null there.
    if (inArray) writeSync(fd, 'null');
    return;
  }
  if (typeof value === 'string') {
    writeString(fd, value);
    return;
  }
  if (value === null || typeof value !== 'object') {
    throw new RangeError(
      `cannot serialise a ${typeof value} too large for one string`,
    );
  }
  if (stack.has(value))
    throw new TypeError('Converting circular structure to JSON');
  stack.add(value);
  if (Array.isArray(value)) {
    writeSync(fd, '[');
    value.forEach((item: unknown, index) => {
      if (index > 0) writeSync(fd, ',');
      writeValue(fd, String(index), item, true, stack);
    });
    writeSync(fd, ']');
  } else {
    writeSync(fd, '{');
    let first = true;
    for (const [member, item] of Object.entries(value)) {
      const shown = prepared(member, item);
      if (
        shown === undefined ||
        typeof shown === 'function' ||
        typeof shown === 'symbol'
      )
        continue;
      if (!first) writeSync(fd, ',');
      first = false;
      writeSync(fd, `${JSON.stringify(member)}:`);
      writeValue(fd, member, shown, false, stack);
    }
    writeSync(fd, '}');
  }
  stack.delete(value);
}

/** Writes `value` to `path` as JSON, however large it is. */
export function writeJsonFile(path: string, value: unknown): void {
  const fd = openSync(path, 'w');
  try {
    writeValue(fd, '', value, false, new Set());
  } finally {
    closeSync(fd);
  }
}
