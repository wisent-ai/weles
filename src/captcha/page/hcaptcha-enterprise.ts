// Enterprise hCaptcha on a sign-in API that answers with a captcha demand:
// the intercepted demand is solved once and the intercepted form is sent
// again with the token, to the endpoint and with the headers it first used.
import type { Page } from 'playwright';
import type { CaptchaSolver } from '../solver.js';
import { deliverCaptchaToken } from './token.js';

/** What the session's network observer kept of the refused sign-in call. */
export type CaptchaSession = {
  captchaResponse?: {
    captcha_sitekey?: string;
    captcha_rqdata?: string;
    captcha_rqtoken?: string;
  };
  captchaFormData?: Record<string, unknown>;
  captchaHeaders: Record<string, string>;
  captchaEndpoint: string;
  proxyConfig?: {
    server: string;
    username?: string;
    password?: string;
  } | null;
};

type Resubmission = { ok: boolean; status: number; text: string };

/** Runs in the page, so the call carries the page's own cookies and origin. */
async function resubmit({
  endpoint,
  headers,
  body,
}: {
  endpoint: string;
  headers: Record<string, string>;
  body: string;
}): Promise<Resubmission> {
  const response = await fetch(endpoint, { method: 'POST', headers, body });
  return {
    ok: response.ok,
    status: response.status,
    text: await response.text(),
  };
}

/** Whether the endpoint's refusal asks for a captcha again. */
function asksForCaptchaAgain(text: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    console.log(
      `[captcha] the resubmission's answer is not JSON (${String(error)}): ${text}`,
    );
  }
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    Object.hasOwn(parsed, 'captcha_key')
  );
}

export async function solveHcaptchaEnterprise(
  page: Page,
  sitekey: string,
  solver: CaptchaSolver,
  session: CaptchaSession | undefined,
): Promise<boolean> {
  const url = page.url();
  const demand = session?.captchaResponse;
  const form = session?.captchaFormData;
  if (!session || !demand || !form) {
    console.log(
      `[captcha] No intercepted API data (captchaResponse=${!!demand} formData=${!!form}), solving the widget's token for the page`,
    );
    // Without an intercepted form there is nothing to resubmit: the token is
    // handed to the widget's own response fields and callbacks, and only a
    // page that took it counts as solved.
    const token = await solver.solveHcaptcha(sitekey, url);
    return deliverCaptchaToken(page, 'hcaptcha', token);
  }
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const demandedKey = demand.captcha_sitekey || sitekey;
  console.log(
    `[captcha] Enterprise hCaptcha: sitekey=${demandedKey} rqdata=${!!demand.captcha_rqdata} ua=${userAgent}`,
  );
  // One solve and one resubmission: asking again for a captcha means the
  // provider's token was refused, which a second token on the same flagged
  // session does not change.
  const token = await solver.solveHcaptcha(demandedKey, url, {
    ...(demand.captcha_rqdata
      ? {
          enterprisePayload: {
            rqdata: demand.captcha_rqdata,
            rqtoken: demand.captcha_rqtoken,
          },
        }
      : {}),
    userAgent,
    ...(session.proxyConfig ? { proxy: session.proxyConfig } : {}),
  });
  console.log('[captcha] Enterprise hCaptcha solved, resubmitting');
  form.captcha_key = token;
  if (demand.captcha_rqtoken) form.captcha_rqtoken = demand.captcha_rqtoken;
  const result = await page.evaluate(resubmit, {
    endpoint: session.captchaEndpoint,
    headers: { 'Content-Type': 'application/json', ...session.captchaHeaders },
    body: JSON.stringify(form),
  });
  console.log(
    `[captcha] Resubmit to ${session.captchaEndpoint}: HTTP ${result.status} ${result.text}`,
  );
  if (result.ok) return true;
  if (asksForCaptchaAgain(result.text))
    console.log(
      '[captcha] hcaptcha_enterprise_token_refused: the endpoint asked for a captcha again',
    );
  return false;
}
