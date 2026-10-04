// The standard values of the page routes, in one place.
//
// The standard viewport is the one echo-web's competitor research used before
// it moved onto Weles, so its readings stay comparable. A page is read once it
// reaches the load state the caller names; nothing here pauses for a fixed time.
// No size, length or count of what a caller sends or gets back is chosen here:
// the page is read whole, the screenshot is a lossless PNG, the download is
// the page's own file, and how many pages run at once is the number of
// processors the host reports.

import { availableParallelism } from 'node:os';

export const STANDARD_VIEWPORT = Object.freeze({ width: 1365, height: 900 });
export const LOAD_STATES = Object.freeze(['domcontentloaded', 'load', 'networkidle']);
export const STANDARD_LOAD_STATE = 'load';
export const SCREENSHOT_MODES = Object.freeze(['none', 'viewport', 'full']);
export const NO_SCREENSHOT = 'none';
export const FULL_SCREENSHOT = 'full';
export const CONCURRENT_PAGES = availableParallelism();
export const HTTP_OK = 200;
export const HTTP_INVALID_REQUEST = 400;
export const HTTP_TARGET_REFUSED = 422;
export const HTTP_BUSY = 429;
export const HTTP_UPSTREAM_FAILED = 502;
