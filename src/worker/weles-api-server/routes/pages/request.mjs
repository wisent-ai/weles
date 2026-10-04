// What a caller may ask of a page route, checked before a browser opens.
//
// Both routes take typed steps, never a script: a caller names a public page,
// the viewport, which load state the page must reach, and for a form export the
// fields to fill and the button that exports. A request of the wrong shape is
// refused with the field that broke it, so the caller learns what to change
// instead of seeing a browser error from deep inside a run. No length or count
// is chosen here; the browser refuses what it cannot do and its refusal is
// returned. A field the caller omits takes the documented standard value
// (constants.mjs); the answer echoes every value used.

import {
  LOAD_STATES,
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

function positiveInteger(body, field, standard) {
  const value = Object.hasOwn(body, field) ? body[field] : standard;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PageRequestRefused(field, 'must be a positive integer');
  }
  return value;
}

function text(value, field, { required }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new PageRequestRefused(field, 'is required');
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new PageRequestRefused(field, 'must be text');
  }
  return value;
}

function viewportOf(body) {
  const viewport = Object.hasOwn(body, 'viewport') ? body.viewport : STANDARD_VIEWPORT;
  if (typeof viewport !== 'object' || viewport === null) {
    throw new PageRequestRefused('viewport', 'must be { width, height }');
  }
  return {
    width: positiveInteger(viewport, 'width', STANDARD_VIEWPORT.width),
    height: positiveInteger(viewport, 'height', STANDARD_VIEWPORT.height),
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
    url: text(body.url, 'url', { required: true }),
    viewport: viewportOf(body),
    userAgent: text(body.user_agent, 'user_agent', { required: false }),
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
  if (!Array.isArray(fields)) {
    throw new PageRequestRefused('fields', 'must be a list of { selector, value }');
  }
  return {
    ...request,
    fields: fields.map((field, index) => ({
      selector: text(field?.selector, `fields[${index}].selector`, { required: true }),
      value: text(field?.value, `fields[${index}].value`, { required: true }),
    })),
    clickText: text(body.click_text, 'click_text', { required: true }),
  };
}
