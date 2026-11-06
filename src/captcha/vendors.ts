/**
 * Where each captcha vendor serves its widget from: the one list the page
 * detector (./detect.ts) searches a live page's frames with and the exit probe
 * (../proxy/quality/platform_probes.ts) reads a fetched page's frames and
 * scripts with. A source belongs to a vendor when its address holds one of the
 * vendor's markers.
 */
export const CAPTCHA_SOURCES = {
  recaptcha: ['recaptcha'],
  turnstile: ['challenges.cloudflare.com'],
  hcaptcha: ['hcaptcha.com'],
  funcaptcha: ['arkoselabs', 'funcaptcha'],
} as const;

export type CaptchaSources = typeof CAPTCHA_SOURCES;
export type CaptchaVendor = keyof CaptchaSources;

/** The vendor whose widget `address` serves, or null for any other address. */
export function captchaVendor(address: URL): CaptchaVendor | null {
  for (const [vendor, markers] of Object.entries(CAPTCHA_SOURCES)) {
    if (markers.some((marker) => address.href.includes(marker))) {
      return vendor as CaptchaVendor;
    }
  }
  return null;
}
