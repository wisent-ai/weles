// The LinkedIn signup probe a candidate exit is put through before it is
// trusted (the TikTok routing probe is ./tiktok_routing.ts; the persona
// headers both fetch with are ./probe_headers.ts). Split out of policy.ts,
// which keeps the provider rules and the geo/reputation checks.

import { captchaVendor } from '../../captcha/vendors.js';
import { type LinkedInProbePersona, probeHeaders } from './probe_headers.js';

export { type LinkedInProbePersona, probeHeaders };
export type LinkedInProbeResult = 'form' | 'challenge' | 'unknown';

/** Where LinkedIn sends a visitor it challenges before any page of its own. */
const CHECKPOINT_PATH = '/checkpoint/';

/**
 * The addresses the page's frames and scripts load, resolved against the
 * page as the browser resolves them. A `src` no browser could load (not a
 * URL) loads nothing and is not one.
 */
function embeddedSources(body: string, page: string): URL[] {
  const sources: URL[] = [];
  for (const [tag] of body.matchAll(/<(?:iframe|script)\b[^>]*>/gi)) {
    const src = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = (src?.[1] ?? src?.[2] ?? src?.[3])?.replaceAll('&amp;', '&');
    if (value && URL.canParse(value, page)) sources.push(new URL(value, page));
  }
  return sources;
}

export async function probeLinkedinSignup(
  proxyUrl: string,
  persona?: LinkedInProbePersona,
): Promise<{
  result: LinkedInProbeResult;
  bytes?: number;
  request?: {
    tool: 'curl';
    target_url: string;
    method: 'GET';
    header_order: string[];
    headers: Record<string, string>;
    persona?: {
      os?: string;
      browser?: string;
      user_agent_os?: string;
      accept_language?: string;
    };
  };
  transport?: {
    curl_version?: string;
    curl_features?: string[];
    http_code?: number;
    http_version?: string;
    num_connects?: number;
    num_headers?: number;
    ssl_verify_result?: number;
    time_connect?: number;
    time_appconnect?: number;
    time_starttransfer?: number;
    time_total?: number;
    meta_error?: string;
  };
  body_markers?: {
    login_form: boolean;
    signup_form: boolean;
    challenge_dialog_template: boolean;
    invisible_recaptcha_enterprise_anchor: boolean;
    checkpoint_redirect: boolean;
    challenge_sources: string[];
    hard_challenge: boolean;
  };
  response_body?: {
    encoding: 'utf8';
    text: string;
    bytes: number;
  };
  error?: string;
}> {
  if (!proxyUrl) return { result: 'unknown' };
  const targetUrl = 'https://www.linkedin.com/signup';
  let headers: Record<string, string>;
  try {
    headers = probeHeaders(persona);
  } catch (error) {
    // A persona the probe cannot present is the probe's own refusal, kept
    // with the verdict, not a guess at the browser.
    return { result: 'unknown', error: (error as Error).message };
  }
  const headerOrder = Object.keys(headers);
  const request = {
    tool: 'curl' as const,
    target_url: targetUrl,
    method: 'GET' as const,
    header_order: headerOrder,
    headers,
    persona: persona
      ? {
          os: persona.os,
          browser: persona.browser,
          user_agent_os: persona.userAgentOs,
          accept_language: persona.acceptLanguage,
        }
      : undefined,
  };
  let curlVersion = '';
  let curlFeatures: string[] = [];
  try {
    const { execFileSync } = await import('node:child_process');
    const versionOut = execFileSync('curl', ['--version'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024,
    });
    const lines = versionOut.split(/\r?\n/);
    curlVersion = lines[0]?.trim() ?? '';
    const features = lines.find((l) => l.startsWith('Features:'));
    curlFeatures = features
      ? features
          .replace(/^Features:\s*/, '')
          .split(/\s+/)
          .filter(Boolean)
      : [];

    const args = [
      '-sS',
      '--compressed',
      '-x',
      proxyUrl,
      ...headerOrder.flatMap((name) => ['-H', `${name}: ${headers[name]}`]),
      '-w',
      '\n__CURL_META__%{json}',
      targetUrl,
    ];
    const out = execFileSync('curl', args, {
      encoding: 'utf8',
      maxBuffer: Infinity,
    });
    const marker = '\n__CURL_META__';
    const idx = out.lastIndexOf(marker);
    const body = idx >= 0 ? out.slice(0, idx) : out;
    const metaRaw = idx >= 0 ? out.slice(idx + marker.length) : '';
    // curl's -w JSON is the only source of the transport fields; when it is
    // missing or does not parse, the fields stay absent and meta_error says
    // why, instead of an empty object reading as "curl reported nothing".
    let meta: any = {};
    let metaError: string | undefined;
    if (!metaRaw) metaError = 'curl printed no __CURL_META__ block';
    else
      try {
        meta = JSON.parse(metaRaw);
      } catch (error) {
        metaError = `curl's metadata is not JSON: ${(error as Error).message}`;
      }
    const responseBody = {
      encoding: 'utf8' as const,
      text: body,
      bytes: body.length,
    };
    // A hard challenge is structure, not words on the page: LinkedIn sending
    // the request to its checkpoint, a frame of that checkpoint, or a frame or
    // script a captcha vendor serves. reCAPTCHA Enterprise's invisible anchor
    // is LinkedIn's passive check on every signup page and challenges no one.
    const sources = embeddedSources(body, targetUrl);
    const invisibleRecaptchaEnterpriseAnchor = sources.some(
      (source) =>
        source.pathname.includes('/recaptcha/enterprise/anchor') &&
        source.searchParams.get('size') === 'invisible',
    );
    const checkpointRedirect =
      typeof meta.redirect_url === 'string' &&
      URL.canParse(meta.redirect_url) &&
      new URL(meta.redirect_url).pathname.startsWith(CHECKPOINT_PATH);
    const challengeSources = sources.filter((source) => {
      if (source.pathname.startsWith(CHECKPOINT_PATH)) return true;
      const vendor = captchaVendor(source);
      return (
        vendor !== null &&
        !(vendor === 'recaptcha' && invisibleRecaptchaEnterpriseAnchor)
      );
    });
    const bodyMarkers = {
      login_form: /name="session_key"|id="username"|input type="email"/.test(
        body,
      ),
      signup_form:
        /name="email-address"|id="email-address"|join-form-submit/.test(body),
      challenge_dialog_template: body.includes('challenge-dialog'),
      invisible_recaptcha_enterprise_anchor: invisibleRecaptchaEnterpriseAnchor,
      checkpoint_redirect: checkpointRedirect,
      challenge_sources: challengeSources.map(
        (source) => `${source.origin}${source.pathname}`,
      ),
      hard_challenge: checkpointRedirect || challengeSources.length > 0,
    };
    const transport = {
      curl_version: curlVersion,
      curl_features: curlFeatures,
      http_code:
        typeof meta.http_code === 'number' ? meta.http_code : undefined,
      http_version:
        typeof meta.http_version === 'string' ? meta.http_version : undefined,
      num_connects:
        typeof meta.num_connects === 'number' ? meta.num_connects : undefined,
      num_headers:
        typeof meta.num_headers === 'number' ? meta.num_headers : undefined,
      ssl_verify_result:
        typeof meta.ssl_verify_result === 'number'
          ? meta.ssl_verify_result
          : undefined,
      time_connect:
        typeof meta.time_connect === 'number' ? meta.time_connect : undefined,
      time_appconnect:
        typeof meta.time_appconnect === 'number'
          ? meta.time_appconnect
          : undefined,
      time_starttransfer:
        typeof meta.time_starttransfer === 'number'
          ? meta.time_starttransfer
          : undefined,
      time_total:
        typeof meta.time_total === 'number' ? meta.time_total : undefined,
      meta_error: metaError,
    };
    if (bodyMarkers.signup_form && !bodyMarkers.hard_challenge)
      return {
        result: 'form',
        bytes: responseBody.bytes,
        request,
        transport,
        body_markers: bodyMarkers,
        response_body: responseBody,
      };
    return {
      result: bodyMarkers.hard_challenge ? 'challenge' : 'unknown',
      bytes: responseBody.bytes,
      request,
      transport,
      body_markers: bodyMarkers,
      response_body: responseBody,
    };
  } catch (e: any) {
    return {
      result: 'unknown',
      request,
      transport: { curl_version: curlVersion, curl_features: curlFeatures },
      error: String(e?.message ?? e).replaceAll(proxyUrl, '[proxy-url]'),
    };
  }
}
