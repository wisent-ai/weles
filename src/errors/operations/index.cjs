// Every Weles operation that declares how it fails, in the order the errors
// page lists them.
'use strict';

const admission = require('./admission.cjs');
const browser = require('./browser.cjs');
const signin = require('./sign-in.cjs');

const OPERATIONS = Object.freeze([
  admission.SUBMIT,
  admission.STATUS,
  admission.CANCEL,
  browser.SESSION,
  signin.SIGN_IN,
]);

module.exports = { OPERATIONS };
