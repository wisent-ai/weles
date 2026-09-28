// What a caller may ask of a page route, checked before a browser opens.
//
// Both routes take typed steps, never a script: a caller names a public page,
// the viewport, which load state the page must reach, and for a form export the
// fields to fill and the button that exports. A request outside these bounds is
// refused with the field that broke it, so the caller learns what to change
// instead of seeing a browser error from deep inside a run. A field the caller
// omits takes the documented standard value (constants.mjs); the answer echoes
// every value used.

import {
  LOAD_STATES,
  MAX_CLICK_TEXT_CHARS,
  MAX_FIELD_VALUE_CHARS,
  MAX_FIELDS,
  MAX_SELECTOR_CHARS,
  MAX_USER_AGENT_CHARS,
  MAX_VIEWPORT_SIDE,
  MIN_VIEWPORT_SIDE,
  NO_SCREENSHOT,
  SCREENSHOT_MODES,
  STANDARD_LOAD_STATE,
  STANDARD_VIEWPORT,
} from './constants.mjs';

export class PageRequestRefused extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'PageRequestRefused';
    this.field = field;
  }
}

function boundedInteger(body, field, standard, minimum, maximum) {
  const value = Object.hasOwn(body, field) ? body[field] : standard;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new PageRequestRefused(field, `must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function boundedText(value, field, maximum, { required }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new PageRequestRefused(field, 'is required');
    return undefined;
  }
  if (typeof value !== 'string' || value.length > maximum) {
    throw new PageRequestRefused(field, `must be text of at most ${maximum} characters`);
  }
  return value;
}

function viewportOf(body) {
  const viewport = Object.hasOwn(body, 'viewport') ? body.viewport : STANDARD_VIEWPORT;
  if (typeof viewport !== 'object' || viewport === null) {
    throw new PageRequestRefused('viewport', 'must be { width, height }');
  }
  return {
    width: boundedInteger(viewport, 'width', STANDARD_VIEWPORT.width, MIN_VIEWPORT_SIDE, MAX_VIEWPORT_SIDE),
    height: boundedInteger(viewport, 'height', STANDARD_VIEWPORT.height, MIN_VIEWPORT_SIDE, MAX_VIEWPORT_SIDE),
  };
}

function common(body) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new PageRequestRefused('body', 'must be a JSON object');
  }
  const loadState = Object.hasOwn(body, 'load_state') ? body.load_state : STANDARD_LOAD_STATE;
  if (!LOAD_STATES.includes(loadState)) {
    throw new PageRequestRefused('load_state', `must be one of ${LOAD_STATES.join(', ')}`);
  }
  return {
    url: boundedText(body.url, 'url', Number.MAX_SAFE_INTEGER, { required: true }),
    viewport: viewportOf(body),
    userAgent: boundedText(body.user_agent, 'user_agent', MAX_USER_AGENT_CHARS, { required: false }),
    loadState,
  };
}

/** POST /pages/snapshot: one page read as text, structure and an optional image. */
export function snapshotRequest(body) {
  const request = common(body);
  const screenshot = Object.hasOwn(body, 'screenshot') ? body.screenshot : NO_SCREENSHOT;
  if (!SCREENSHOT_MODES.includes(screenshot)) {
    throw new PageRequestRefused('screenshot', `must be one of ${SCREENSHOT_MODES.join(', ')}`);
  }
  return { ...request, screenshot };
}

/** POST /pages/form-export: fill named fields, press one button, return the file it downloads. */
export function formExportRequest(body) {
  const request = common(body);
  const fields = Object.hasOwn(body, 'fields') ? body.fields : [];
  if (!Array.isArray(fields) || fields.length > MAX_FIELDS) {
    throw new PageRequestRefused('fields', `must be a list of at most ${MAX_FIELDS} { selector, value }`);
  }
  return {
    ...request,
    fields: fields.map((field, index) => ({
      selector: boundedText(field?.selector, `fields[${index}].selector`, MAX_SELECTOR_CHARS, { required: true }),
      value: boundedText(field?.value, `fields[${index}].value`, MAX_FIELD_VALUE_CHARS, { required: true }),
    })),
    clickText: boundedText(body.click_text, 'click_text', MAX_CLICK_TEXT_CHARS, { required: true }),
  };
}
