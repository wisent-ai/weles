// Which generated identity a secret acquisition registers with, and what the
// agent is told about using it.

/** The platform whose identity the requested secret is registered under, or ''. */
export function identityPlatformFromConstraints(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const secret = String(value.secret || '').toLowerCase();
  if (secret === 'semantic_scholar.api_key') return 'semantic_scholar';
  if (secret === 'brave.search_api_key') return 'brave';
  return '';
}

/** The session platform: an explicit account-bound one, else the identity platform. */
export function sessionPlatformFromConstraints(value) {
  const identityPlatform = identityPlatformFromConstraints(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return identityPlatform;
  const explicit = typeof value.session_platform === 'string'
    ? value.session_platform.trim().toLowerCase()
    : '';
  if (!explicit) return identityPlatform;
  if (!process.env.ACCOUNT_ID?.trim()) {
    throw new Error('constraints.session_platform requires an account-bound task');
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(explicit)) {
    throw new Error('constraints.session_platform is invalid');
  }
  return explicit;
}

/** The instructions appended to the objective when a generated identity is in play. */
export function identityInstructions(platform) {
  if (!platform) return [];
  const prefix = platform.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const instructions = [
    'Weles generated a registration email identity through its domain rotator / Resend inbox for this run.',
    'Use fill_identity(target, field) for generated email, password, username, first_name, last_name, and birth-date fields. The generated values stay inside WSession and never appear in model tool arguments or results.',
    `If the site sends an email confirmation, call check_email("$${prefix}_NEW_EMAIL", "") and follow the returned code, link, or instructions before attempting to sign in.`,
    'Do not return raw API keys in done(value). Store newly issued token or API-key material only through store_credential.',
  ];
  if (platform === 'semantic_scholar') {
    instructions.push(
      'On Semantic Scholar\'s API page, fill and submit the HubSpot form embedded in the Request an API Key / api-key-form iframe; do not use the footer newsletter form.',
      'Semantic Scholar API-key iframe exact field plan: fill firstname, lastname, email, company, 0-2/website, country_choice, message, api_endpoints, and api_requests_per_second; choose the Public application radio (input[name="application"]); tick every API acknowledgement/terms checkbox, especially input[name="api_successful_unauth_requests"]; if CAPTCHA/Turnstile/reCAPTCHA appears, call solve_captcha before giving up; then click Submit inside that same iframe. If validation errors remain, repair those exact fields before retrying submit. Post-submit key-delivery email is handled by the server-side Semantic Scholar follow-up scanner.',
    );
  }
  if (platform === 'brave') {
    instructions.push(
      'Brave Search exact plan: create one account with the generated Brave identity and fill every required registration field. Call solve_captcha exactly once after the form is valid; Brave uses a proof-of-work Register control, so solve_captcha clicks it, waits for the proof, and automatically submits the form. After solve_captcha succeeds, do not click Register again: wait for the registration response, then check the generated mailbox for Brave verification before trying to log in. Keep using that same identity; never restart registration with invented credentials. After verification, sign in, open the API Keys area, select only a no-payment/free Search API option when required, create one key, and call store_credential on the displayed key.',
    );
  }
  return instructions;
}
