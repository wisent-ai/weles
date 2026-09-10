// The two platform probes a candidate exit is put through before it is
// trusted: the LinkedIn signup page as a real browser would fetch it, and
// the region TikTok routes the exit to. Split out of policy.ts, which keeps
// the provider rules and the geo/reputation checks.

export type LinkedInProbeResult = 'form' | 'challenge' | 'unknown';
export type LinkedInProbePersona = {
  os?: 'macos' | 'windows' | 'linux' | string;
  browser?: 'chromium' | 'firefox' | 'webkit' | string;
  chromeVersion?: string;
  userAgentOs?: string;
  acceptLanguage?: string;
};

function linkedinProbeHeaders(persona?: LinkedInProbePersona): Record<string, string> {
  const browser = persona?.browser ?? 'chromium';
  const acceptLanguage = persona?.acceptLanguage ?? (browser === 'firefox' ? 'en-US,en;q=0.5' : 'en-US,en;q=0.9');
  const chromeMajor = (persona?.chromeVersion ?? '147.0.0.0').split('.')[0] || '147';
  if (browser === 'firefox') {
    const os = persona?.os === 'windows' ? 'Windows NT 10.0; Win64; x64'
      : persona?.os === 'linux' ? 'X11; Linux x86_64'
      : 'Macintosh; Intel Mac OS X 10.15';
    return {
      'User-Agent': `Mozilla/5.0 (${os}; rv:142.0) Gecko/20100101 Firefox/142.0`,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': acceptLanguage,
      'Upgrade-Insecure-Requests': '1',
    };
  }
  const uaOs = persona?.userAgentOs ?? 'Macintosh; Intel Mac OS X 10_15_7';
  const chPlatform = persona?.os === 'windows' ? '"Windows"' : persona?.os === 'linux' ? '"Linux"' : '"macOS"';
  return {
    'User-Agent': `Mozilla/5.0 (${uaOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
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

export async function probeLinkedinSignup(proxyUrl: string, secs = 8, persona?: LinkedInProbePersona): Promise<{
  result: LinkedInProbeResult;
  bytes?: number;
  request?: {
    tool: 'curl';
    target_url: string;
    method: 'GET';
    timeout_secs: number;
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
  };
  body_markers?: {
    login_form: boolean;
    signup_form: boolean;
    challenge_dialog_template: boolean;
    security_verification_template: boolean;
    hard_challenge: boolean;
    challenge_terms: boolean;
  };
  response_body?: {
    encoding: 'utf8';
    text: string;
    bytes: number;
    truncated: boolean;
    max_bytes: number;
  };
  error?: string;
}> {
  if (!proxyUrl) return { result: 'unknown' };
  const targetUrl = 'https://www.linkedin.com/signup';
  const headers = linkedinProbeHeaders(persona);
  const headerOrder = Object.keys(headers);
  const request = {
    tool: 'curl' as const,
    target_url: targetUrl,
    method: 'GET' as const,
    timeout_secs: secs,
    header_order: headerOrder,
    headers,
    persona: persona ? {
      os: persona.os,
      browser: persona.browser,
      user_agent_os: persona.userAgentOs,
      accept_language: persona.acceptLanguage,
    } : undefined,
  };
  let curlVersion = '';
  let curlFeatures: string[] = [];
  try {
    const { execFileSync } = await import('node:child_process');
    const versionOut = execFileSync('curl', ['--version'], { encoding: 'utf8', maxBuffer: 256 * 1024 });
    const lines = versionOut.split(/\r?\n/);
    curlVersion = lines[0]?.trim() ?? '';
    const features = lines.find(l => l.startsWith('Features:'));
    curlFeatures = features ? features.replace(/^Features:\s*/, '').split(/\s+/).filter(Boolean) : [];

    const args = ['-sS', '--compressed', '--max-time', String(secs), '-x', proxyUrl,
      ...headerOrder.flatMap((name) => ['-H', `${name}: ${headers[name]}`]),
      '-w', '\n__CURL_META__%{json}',
      targetUrl];
    const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const marker = '\n__CURL_META__';
    const idx = out.lastIndexOf(marker);
    const body = idx >= 0 ? out.slice(0, idx) : out;
    const metaRaw = idx >= 0 ? out.slice(idx + marker.length) : '';
    let meta: any = {};
    try { meta = metaRaw ? JSON.parse(metaRaw) : {}; } catch {}
    const bytes = body.length;
    const maxBodyBytes = Number(process.env.WELES_LINKEDIN_PREFLIGHT_BODY_MAX_BYTES ?? 1_000_000);
    const responseBody = {
      encoding: 'utf8' as const,
      text: body.slice(0, maxBodyBytes),
      bytes,
      truncated: body.length > maxBodyBytes,
      max_bytes: maxBodyBytes,
    };
    const invisibleRecaptchaEnterpriseAnchor =
      /(?:google\.com\/)?recaptcha\/enterprise\/anchor[\s\S]{0,500}(?:[?&]|%26)size(?:=|%3D)invisible/i.test(body);
    const hardCaptcha =
      /checkpoint\/challenge|challengeIframe|px-cloud|arkoselabs|funcaptcha|hcaptcha/i.test(body) ||
      ((/g-recaptcha|google\.com\/recaptcha|recaptcha/i.test(body)) && !invisibleRecaptchaEnterpriseAnchor);
    const bodyMarkers = {
      login_form: /name="session_key"|id="username"|input type="email"/.test(body),
      signup_form: /name="email-address"|id="email-address"|join-form-submit/.test(body),
      challenge_dialog_template: /challenge-dialog/i.test(body),
      security_verification_template: /Security verification/i.test(body),
      invisible_recaptcha_enterprise_anchor: invisibleRecaptchaEnterpriseAnchor,
      hard_challenge: hardCaptcha,
      challenge_terms: /checkpoint|challenge|captcha|recaptcha|security/i.test(body),
    };
    const transport = {
      curl_version: curlVersion,
      curl_features: curlFeatures,
      http_code: typeof meta.http_code === 'number' ? meta.http_code : undefined,
      http_version: typeof meta.http_version === 'string' ? meta.http_version : undefined,
      num_connects: typeof meta.num_connects === 'number' ? meta.num_connects : undefined,
      num_headers: typeof meta.num_headers === 'number' ? meta.num_headers : undefined,
      ssl_verify_result: typeof meta.ssl_verify_result === 'number' ? meta.ssl_verify_result : undefined,
      time_connect: typeof meta.time_connect === 'number' ? meta.time_connect : undefined,
      time_appconnect: typeof meta.time_appconnect === 'number' ? meta.time_appconnect : undefined,
      time_starttransfer: typeof meta.time_starttransfer === 'number' ? meta.time_starttransfer : undefined,
      time_total: typeof meta.time_total === 'number' ? meta.time_total : undefined,
    };
    if (bodyMarkers.signup_form && !bodyMarkers.hard_challenge) return { result: 'form', bytes, request, transport, body_markers: bodyMarkers, response_body: responseBody };
    return { result: bodyMarkers.hard_challenge ? 'challenge' : 'unknown', bytes, request, transport, body_markers: bodyMarkers, response_body: responseBody };
  } catch (e: any) {
    return {
      result: 'unknown',
      request,
      transport: { curl_version: curlVersion, curl_features: curlFeatures },
      error: String(e?.message ?? e).replace(proxyUrl, '[proxy-url]').slice(0, 200),
    };
  }
}

// TikTok edge-classifier probe. The /signup HTML embeds a SIGI_STATE
// "vregion" value that pins mssdk routing for the rest of the session:
// "US-TTP" = standard (mssdk.tiktokw.us), "US-TTP2" = high-risk
// (mssdk-ttp2.tiktokw.us) where the security SDK never completes init
// and the click handler bails before firing /send_code/. 2026-05-02
// probe of 5 random BrightData residential stickies: 4 US-TTP2, 1 US-TTP.
// Reject US-TTP2 stickies in preflight; resolveProxy 8-attempt loop
// walks past them before binding the browser.
export type RoutingResult = 'standard' | 'high_risk' | 'unknown';
async function probeOnce(proxyUrl: string, secs: number): Promise<{ vregion: string | null; bytes: number }> {
  try {
    const { execSync } = await import('node:child_process');
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';
    // Chromium-realistic header set (mirrors the linkedin probe pattern):
    // a plain UA-only curl can pass while real Chromium fails — TikTok's
    // edge gates on sec-ch-ua + Accept-Language too. Match what Chromium
    // actually sends so probe verdict tracks browser behaviour.
    const args = ['-s', '--max-time', String(secs), '-x', proxyUrl,
      '-H', `User-Agent: ${ua}`,
      '-H', 'sec-ch-ua: "Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
      '-H', 'sec-ch-ua-mobile: ?0', '-H', 'sec-ch-ua-platform: "macOS"',
      '-H', 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9',
      '-H', 'Accept-Language: en-US,en;q=0.9',
      'https://www.tiktok.com/signup'];
    const body = execSync(`curl ${args.map(a => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const m = body.match(/"vregion":"([A-Z0-9-]{1,20})"/);
    return { vregion: m ? m[1] : null, bytes: body.length };
  } catch { return { vregion: null, bytes: 0 }; }
}
export async function verifyTikTokRouting(proxyUrl: string, secs = 12): Promise<{ result: RoutingResult; vregion?: string }> {
  if (!proxyUrl) return { result: 'unknown' };
  // Dual probe with Chromium-realistic headers: BrightData sticky sessions
  // can rotate exit IPs between requests, so two back-to-back probes catch
  // drift. Reject any sticky that on either probe (a) lacks vregion,
  // (b) returns TTP2, (c) shows mobile-redirect markers
  // (/login/download-app referenced in /signup body == 1340 at
  // register_verify_login), or (d) drifts vregion across probes.
  const a = await probeOnce(proxyUrl, secs);
  if (!a.vregion) return { result: 'unknown' };
  if (/-TTP2$/i.test(a.vregion)) return { result: 'high_risk', vregion: a.vregion };
  const b = await probeOnce(proxyUrl, secs);
  if (!b.vregion) return { result: 'unknown', vregion: a.vregion };
  if (a.vregion !== b.vregion) return { result: 'high_risk', vregion: `${a.vregion}!=${b.vregion}` };
  if (/-TTP2$/i.test(b.vregion)) return { result: 'high_risk', vregion: b.vregion };
  return { result: 'standard', vregion: a.vregion };
}
