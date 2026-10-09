// Writes one instrumentation artifact as JSON without ever holding the whole
// document as one string. Containers are streamed member by member; string
// chunks are bounded by V8's measured string limit before JSON escaping.
// Bytes match JSON.stringify of the same value with lone UTF-16 surrogates replaced
// by U+FFFD.

import { closeSync, openSync, writeSync } from 'node:fs';
import { constants as bufferConstants } from 'node:buffer';

// JSON escapes one UTF-16 unit into at most six characters (\uXXXX), so a
// slice of this many units always escapes to a string V8 can hold.
const STRING_SLICE = Math.floor(bufferConstants.MAX_STRING_LENGTH / 6);
const SURROGATE = /[\uD800-\uDFFF]/gu;

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
  value: unknown,
  inArray: boolean,
  stack: Set<object>,
): void {
  if (typeof value === 'string') {
    writeString(fd, value);
    return;
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    value instanceof Number ||
    value instanceof Boolean ||
    value instanceof String
  ) {
    const scalar = JSON.stringify(value);
    if (scalar !== undefined) writeSync(fd, scalar);
    else if (inArray) writeSync(fd, 'null');
    return;
  }
  if (stack.has(value))
    throw new TypeError('Converting circular structure to JSON');
  stack.add(value);
  if (Array.isArray(value)) {
    writeSync(fd, '[');
    for (const [index, item] of value.entries()) {
      if (index > 0) writeSync(fd, ',');
      writeValue(fd, prepared(String(index), item), true, stack);
    }
    writeSync(fd, ']');
  } else {
    writeSync(fd, '{');
    let first = true;
    for (const member in value) {
      if (!Object.prototype.hasOwnProperty.call(value, member)) continue;
      const shown = prepared(member, (value as Record<string, unknown>)[member]);
      if (
        shown === undefined ||
        typeof shown === 'function' ||
        typeof shown === 'symbol'
      )
        continue;
      if (!first) writeSync(fd, ',');
      first = false;
      writeSync(fd, `${JSON.stringify(member)}:`);
      writeValue(fd, shown, false, stack);
    }
    writeSync(fd, '}');
  }
  stack.delete(value);
}

/** Writes `value` to `path` as JSON, however large it is. */
export function writeJsonFile(path: string, value: unknown): void {
  const fd = openSync(path, 'w');
  try {
    writeValue(fd, prepared('', value), false, new Set());
  } finally {
    closeSync(fd);
  }
}
