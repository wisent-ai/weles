// How a Weles operation fails, declared once beside the operation.
//
// "Operation did not succeed" is a failure nobody analysed. Each cause an
// operation can meet -- including the ones nobody has met yet -- is written
// down once: which step failed, why, the state the refusal shows, what fixes
// it, its code from the Wisent catalogue (@wisent/errors), the exit or HTTP
// status it leaves, and the real test that provokes it. These are the fields
// wisent-errors' `operation::Cause` declares for Rust products and `stado
// errors show` prints; Weles is JavaScript, so they are declared here, and
// `weles errors check` refuses a declaration that lacks one.
//
// The refusal a person reads, the answer a machine reads, `weles errors show`
// and the documentation page all come from the one declaration, so none of
// them can say something the others do not. CommonJS, so the ECMAScript
// modules of the worker and the TypeScript compiled to CommonJS import it
// alike.
'use strict';

const {
  CODES,
  GENERIC_SENTENCES,
  RETRY_EXIT,
  USAGE_EXIT,
  failure,
  genericSentencesIn,
  httpStatus,
  retryable,
} = require('@wisent/errors');

/** The status a failure that is not a usage refusal exits with (cli/usage.ts FAILURE_STATUS). */
const FAILURE_EXIT = 1;

/** The page every cause is listed on, one anchor per cause. */
const DOCS = 'https://weles.wisent.com/docs/errors';

/**
 * `template` with each `{name}` replaced by its value. A placeholder the
 * raising code gave no value for stays as written, so a forgotten value is
 * visible in the sentence instead of silently becoming nothing.
 */
function fill(template, values) {
  return template.replace(/\{([A-Za-z_]+)\}/g, (whole, name) =>
    Object.hasOwn(values, name) ? String(values[name]) : whole,
  );
}

/** What failed, why, and the state observed, as one sentence. */
function sentence(cause, values) {
  return `${fill(cause.failed, values)}: ${fill(cause.cause, values)}; observed: ${fill(cause.observed, values)}`;
}

/** The status a command leaves when this cause ends it. */
function exitCode(cause) {
  if (cause.usage) return USAGE_EXIT;
  if (retryable(cause.code)) return RETRY_EXIT;
  return FAILURE_EXIT;
}

/** The HTTP status a service answers this cause with: its own, or its code's. */
function statusOf(cause) {
  return cause.status ?? httpStatus(cause.code);
}

/**
 * Where on the errors page this cause is listed: the section of its area,
 * whose table holds one row per cause.
 */
function docOf(cause) {
  return `${DOCS}#${cause.area}`;
}

/**
 * One declared cause, raised. Its message is the sentence; it carries the
 * declaration, the fix and the statuses, so every edge -- the CLI's standard
 * error, an HTTP answer, a JSON-RPC error -- reports the same analysis.
 */
// The installed release loads this module twice -- dist/errors/index.cjs for
// the compiled CLI, src/errors/index.cjs for the plain modules it imports from
// src (the Apple capability issuer) -- so a declared cause is recognised by
// this registered brand, not by which copy of the class made it.
const BRAND = Symbol.for('wisent.weles.declared-error');

class DeclaredError extends Error {
  static [Symbol.hasInstance](value) {
    return Boolean(value && value[BRAND] === true);
  }

  constructor(cause, values = {}, options = undefined) {
    super(sentence(cause, values), options);
    this[BRAND] = true;
    this.name = 'DeclaredError';
    this.declared = cause;
    this.values = values;
    this.remedy = fill(cause.remedy, values);
    // The machine-readable code an HTTP answer has always carried as `error`.
    this.code = cause.wire ?? cause.id;
    this.status = statusOf(cause);
    this.exitCode = exitCode(cause);
  }

  /** The same cause with more of its values named, keeping what it wraps. */
  naming(values) {
    return new DeclaredError(
      this.declared,
      { ...values, ...this.values },
      this.cause === undefined ? undefined : { cause: this.cause },
    );
  }

  /** The answer a machine reads: the cause, the fix and whether retrying helps. */
  answer() {
    return {
      error: this.code,
      message: this.message,
      cause: this.declared.id,
      remedy: this.remedy,
      retryable: retryable(this.declared.code),
      docs: docOf(this.declared),
    };
  }

  /** The lines a person reads under the error line. */
  explanation() {
    return `fix: ${this.remedy}\ncause: ${this.declared.area}.${this.declared.id}; \`weles errors show ${this.declared.area}\` lists every cause, ${docOf(this.declared)}`;
  }

  /** The Wisent failure envelope of this cause. */
  envelope(service) {
    return failure({
      failurePoint: `weles.${this.declared.area}`,
      code: this.declared.code,
      service,
      detail: this.message,
      remedy: this.remedy,
      context: { cause: this.declared.id },
    });
  }
}

/** The message of whatever was thrown, for a cause's observed state. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** One operation's catalogue, as `weles errors show --json` prints it. */
function catalogue(operation) {
  return {
    operation: operation.id,
    command: operation.command,
    summary: operation.summary,
    docs: DOCS,
    causes: operation.causes.map((cause) => ({
      id: cause.id,
      code: cause.code,
      exit: exitCode(cause),
      status: statusOf(cause),
      retryable: retryable(cause.code),
      usage: cause.usage === true,
      failed: cause.failed,
      cause: cause.cause,
      observed: cause.observed,
      remedy: cause.remedy,
      test: cause.test,
      doc: docOf(cause),
    })),
  };
}

const CAUSE_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const TEST_PATH = /^tests\/[^/]+\/[^:]+::[a-z0-9_]+$/;

/** Everything wrong with one operation's declarations, each as one sentence. */
function problems(operation) {
  const found = [];
  if (!operation.causes.length)
    found.push(`${operation.id}: declares no cause`);
  operation.causes.forEach((cause, index) => {
    const id = cause.id;
    const named = `${operation.id}: cause ${JSON.stringify(id)}`;
    if (operation.causes.slice(0, index).some((earlier) => earlier.id === id))
      found.push(`${named} is declared twice`);
    if (!CAUSE_ID.test(id ?? ''))
      found.push(`${named}: the id is not lowercase words joined by '-'`);
    if (!CAUSE_ID.test(cause.area ?? ''))
      found.push(`${named}: it names no area of the errors page`);
    for (const field of ['failed', 'cause', 'observed', 'remedy']) {
      const text = cause[field];
      if (typeof text !== 'string' || !text.trim()) {
        found.push(`${named}: \`${field}\` is empty`);
        continue;
      }
      for (const generic of GENERIC_SENTENCES)
        if (text.toLowerCase().includes(generic.text))
          found.push(
            `${named}: \`${field}\` says "${generic.text}", which ${generic.reason}`,
          );
    }
    if (!CODES.includes(cause.code) || cause.code === 'unknown')
      found.push(
        `${named}: code ${JSON.stringify(cause.code)} is not a declared code of the catalogue (unknown is the catch-all a declaration replaces)`,
      );
    else if (cause.usage === true && retryable(cause.code))
      found.push(
        `${named}: a usage refusal cannot be \`${cause.code}\`, which is retryable`,
      );
    if (!TEST_PATH.test(cause.test ?? ''))
      found.push(
        `${named}: test ${JSON.stringify(cause.test)} is not tests/<area>/<file>::<test name>`,
      );
  });
  return found;
}

/**
 * A frozen cause of `area`. Unless it says otherwise a cause is not a usage
 * refusal, and its HTTP status is its code's.
 */
function declare(area, fields) {
  return Object.freeze({ area, usage: false, ...fields });
}

module.exports = {
  DOCS,
  DeclaredError,
  FAILURE_EXIT,
  catalogue,
  declare,
  docOf,
  exitCode,
  fill,
  genericSentencesIn,
  messageOf,
  problems,
  sentence,
};
