// A thrown value described with every cause it wraps.
//
// Node's fetch throws TypeError('fetch failed') and keeps what actually failed
// (a DNS answer, a refused connection, a connect timeout, a TLS refusal) in
// error.cause; a connection tried on several addresses keeps one failure per
// address in an AggregateError's errors. A refusal that prints only the outer
// message names none of them, so every Weles refusal of a transport failure
// describes the thrown value through describeError. CommonJS, so both the
// ECMAScript modules and the TypeScript compiled to CommonJS import it.
'use strict';

// What a level says is its message and its `code`: a Node system error's
// message already names the call, the code and the host or the address and
// port that failed ("getaddrinfo ENOTFOUND <host>", "connect ECONNREFUSED
// <address>:<port>"), and a TLS or undici failure that names no system call
// still carries its code (CERT_HAS_EXPIRED, UND_ERR_CONNECT_TIMEOUT). No other
// property of any level is read, so a server's response body, a URL with its
// query, a header or an item's value attached to an error is never copied
// into a refusal.
function codeOf(value) {
  const { code } = value;
  return typeof code === 'string' || typeof code === 'number'
    ? String(code)
    : undefined;
}

function level(value) {
  if (!(value instanceof Error)) return String(value);
  const named = value.message.trim() ? value.message : value.name;
  const code = codeOf(value);
  return code === undefined || named.includes(code)
    ? named
    : `${named} (code ${code})`;
}

/**
 * The message of `value` and of every cause under it, outermost first, each
 * with its code when the message does not already hold it: `fetch failed;
 * caused by getaddrinfo ENOTFOUND auth.kimi.com`. The failures an
 * AggregateError holds are each named; a cause met twice is named once.
 */
function describeError(value) {
  const seen = new Set();
  const walk = (current) => {
    if (seen.has(current)) return 'the cause named above';
    seen.add(current);
    if (!(current instanceof Error)) return level(current);
    const parts = [level(current)];
    if (current instanceof AggregateError && current.errors.length)
      parts.push(`each of [${current.errors.map(walk).join('; ')}]`);
    if (current.cause !== undefined)
      parts.push(`caused by ${walk(current.cause)}`);
    return parts.join('; ');
  };
  return walk(value);
}

/**
 * Every error under `value`, outermost first, as data a caller can test:
 * { name, message, code } with code present when the level carries one. An
 * AggregateError's failures follow it in order; a value met twice is listed
 * once.
 */
function causeChain(value) {
  const seen = new Set();
  const levels = [];
  const walk = (current) => {
    if (seen.has(current)) return;
    seen.add(current);
    if (!(current instanceof Error)) {
      levels.push({ name: typeof current, message: String(current) });
      return;
    }
    const code = codeOf(current);
    levels.push({
      name: current.name,
      message: current.message,
      ...(code === undefined ? {} : { code }),
    });
    if (current instanceof AggregateError) current.errors.forEach(walk);
    if (current.cause !== undefined) walk(current.cause);
  };
  walk(value);
  return levels;
}

exports.describeError = describeError;
exports.causeChain = causeChain;
