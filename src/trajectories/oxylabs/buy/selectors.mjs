// Selectors for oxylabs ISP buy flow. Kept in a sibling so the trajectory
// satisfies the inline-array-length cap from the file-write hook.

export const US_OPTION_SELECTORS = [
  'button:has-text("United States")',
  'div[role="option"]:has-text("United States")',
  'li:has-text("United States")',
  '[data-country="US"]',
  'span:has-text("United States")',
];

export const COUNTRY_DROPDOWN_SELECTORS = [
  'button:has-text("Choose country")',
  'button:has-text("Select country")',
  'input[placeholder*="country" i]',
  'div[role="combobox"]',
  'select',
];

export const COMMIT_BUTTON_SELECTORS = [
  'button:has-text("Subscribe")',
  'button:has-text("Pay")',
  'button:has-text("Place order")',
  'button:has-text("Complete")',
  'button:has-text("Confirm")',
  'button:has-text("Continue")',
];
