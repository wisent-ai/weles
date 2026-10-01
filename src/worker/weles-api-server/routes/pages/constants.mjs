// The bounds and standard values of the page routes, in one place.
//
// The standard viewport is the one echo-web's competitor research used before
// it moved onto Weles, so its readings stay comparable. A page is read once it
// reaches the load state the caller names; nothing here pauses for a fixed time.
// The limits keep one request from holding the process memory or the answer
// size past what a synchronous route may: every page route runs inside the one
// Weles process on a shared host.

export const STANDARD_VIEWPORT = Object.freeze({ width: 1365, height: 900 });
export const MIN_VIEWPORT_SIDE = 320;
export const MAX_VIEWPORT_SIDE = 3840;
export const LOAD_STATES = Object.freeze(['domcontentloaded', 'load', 'networkidle']);
export const STANDARD_LOAD_STATE = 'load';
export const MAX_USER_AGENT_CHARS = 200;
export const MAX_FIELDS = 20;
export const MAX_SELECTOR_CHARS = 300;
export const MAX_FIELD_VALUE_CHARS = 10000;
export const MAX_CLICK_TEXT_CHARS = 200;
export const SCREENSHOT_MODES = Object.freeze(['none', 'viewport', 'full']);
export const NO_SCREENSHOT = 'none';
export const FULL_SCREENSHOT = 'full';
export const SCREENSHOT_JPEG_QUALITY = 60;
export const MAX_SCREENSHOT_BYTES = 700000;
export const MAX_DOWNLOAD_BYTES = 10000000;
export const MAX_TEXT_BYTES = 60000;
export const MAX_ITEMS = 40;
export const MAX_PALETTE = 20;
export const CONCURRENT_PAGES = 2;
export const HTTP_OK = 200;
export const HTTP_INVALID_REQUEST = 400;
export const HTTP_TARGET_REFUSED = 422;
export const HTTP_BUSY = 429;
export const HTTP_UPSTREAM_FAILED = 502;
