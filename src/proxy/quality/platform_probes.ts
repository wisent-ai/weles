// The LinkedIn signup probe a candidate exit is put through before it is
// trusted, and the persona headers every exit probe fetches with (the
// TikTok routing probe is ./tiktok_routing.ts). Split out of policy.ts,
// which keeps the provider rules and the geo/reputation checks.

export type LinkedInProbeResult = 'form' | 'challenge' | 'unknown';
export type LinkedInProbePersona = {
  os?: 'macos' | 'windows' | 'linux' | string;
  browser?: 'chromium' | 'firefox' | 'webkit' | string;
  chromeVersion?: string;
  userAgentOs?: string;
  acceptLanguage?: string;
};

/** The navigation headers the run's persona sends, for a probe fetched through an exit. */
export function probeHeaders(
  persona?: LinkedInProbePersona,
): Record<string, string> {
  const browser = persona?.browser ?? 'chromium';
  const acceptLanguage =
    persona?.acceptLanguage ??
    (browser === 'firefox' ? 'en-US,en;q=0.5' : 'en-US,en;q=0.9');
  const chromeMajor =
    (persona?.chromeVersion ?? '147.0.0.0').split('.')[0] || '147';
  if (browser === 'firefox') {
    const os =
      persona?.os === 'windows'
        ? 'Windows NT 10.0; Win64; x64'
        : persona?.os === 'linux'
          ? 'X11; Linux x86_64'
          : 'Macintosh; Intel Mac OS X 10.15';
    return {
      'User-Agent': `Mozilla/5.0 (${os}; rv:142.0) Gecko/20100101 Firefox/142.0`,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': acceptLanguage,
      'Upgrade-Insecure-Requests': '1',
    };
  }
  const uaOs = persona?.userAgentOs ?? 'Macintosh; Intel Mac OS X 10_15_7';
  const chPlatform =
    persona?.os === 'windows'
      ? '"Windows"'
      : persona?.os === 'linux'
        ? '"Linux"'
        : '"macOS"';
  return {
    'User-Agent': `Mozilla/5.0 (${uaOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': acceptLanguage,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Priority: 'u=0, i',
    'sec-ch-ua': `"Google Chrome";v="${chromeMajor}", "Not.A/Brand";v="8", "Chromium";v="${chromeMajor}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': chPlatform,
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
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
  const headers = probeHeaders(persona);
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
    const invisibleRecaptchaEnterpriseAnchor =
      /(?:google\.com\/)?recaptcha\/enterprise\/anchor[\s\S]{0,500}(?:[?&]|%26)size(?:=|%3D)invisible/i.test(
        body,
      );
    // A hard challenge is a captcha provider's script or frame on the page, or
    // LinkedIn's own checkpoint challenge frame.
    const hardCaptcha =
      [
        'checkpoint/challenge',
        'challengeIframe',
        'px-cloud.net',
        'arkoselabs.com',
        'funcaptcha.com',
        'hcaptcha.com',
      ].some((marker) => body.includes(marker)) ||
      (['google.com/recaptcha', 'recaptcha.net'].some((marker) =>
        body.includes(marker),
      ) &&
        !invisibleRecaptchaEnterpriseAnchor);
    const bodyMarkers = {
      login_form: /name="session_key"|id="username"|input type="email"/.test(
        body,
      ),
      signup_form:
        /name="email-address"|id="email-address"|join-form-submit/.test(body),
      challenge_dialog_template: body.includes('challenge-dialog'),
      invisible_recaptcha_enterprise_anchor: invisibleRecaptchaEnterpriseAnchor,
      hard_challenge: hardCaptcha,
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
