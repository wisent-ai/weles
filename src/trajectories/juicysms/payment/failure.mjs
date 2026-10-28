// The refusal every step of a JuicySMS top-up throws: an Error carrying a
// stable code and the observed details that explain it.

/** An error with `code` and `details` spread onto it, so the run's report keeps both. */
export function failure(code, message, details) {
  return Object.assign(new Error(message), { code, ...details });
}
