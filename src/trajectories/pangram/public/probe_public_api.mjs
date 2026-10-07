// Probe Pangram's public no-account anonymous scan endpoint once.
// Does not use stored accounts/cookies and does not bypass Turnstile.

const API = 'https://web.pangram.com';
const text = process.env.PANGRAM_TEXT || 'To jest krotki tekst testowy uzyty wylacznie do sprawdzenia publicznego endpointu Pangram bez logowania.';
const turnstileToken = process.env.PANGRAM_TURNSTILE_TOKEN || '';

function cookiesFrom(headers) {
  const raw = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie')].filter(Boolean);
  return raw.map((c) => String(c).split(';')[0]).filter(Boolean).join('; ');
}

const csrfResp = await fetch(`${API}/api/accounts/get-csrf/`, {
  headers: {
    accept: 'application/json',
    origin: 'https://www.pangram.com',
    referer: 'https://www.pangram.com/',
  },
});
const csrfCookie = cookiesFrom(csrfResp.headers);
const csrfJson = await csrfResp.json().catch(() => ({}));
const csrfToken = csrfJson.csrfToken || csrfJson.csrf_token || '';

const sharedHeaders = {
  accept: 'application/json',
  origin: 'https://www.pangram.com',
  referer: 'https://www.pangram.com/',
  cookie: csrfCookie,
  'x-csrftoken': csrfToken,
};

const remainingResp = await fetch(`${API}/api/anonymous-scan/remaining/`, {
  headers: sharedHeaders,
});
const remainingBody = await remainingResp.text();

const postResp = await fetch(`${API}/api/anonymous-scan/`, {
  method: 'POST',
  headers: {
    ...sharedHeaders,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ text, turnstile_token: turnstileToken }),
});
const body = await postResp.text();
let postJson = null;
try { postJson = JSON.parse(body); } catch {}

// One read of the scan status; the probe reports what the endpoint says now.
let status = null;
const taskId = postJson?.task_id || postJson?.taskId || null;
if (taskId) {
  const statusResp = await fetch(`${API}/api/anonymous-scan/status/${encodeURIComponent(taskId)}/`, {
    headers: sharedHeaders,
  });
  const statusText = await statusResp.text();
  status = {
    statusCode: statusResp.status,
    contentType: statusResp.headers.get('content-type'),
    bodySample: statusText.replace(/\s+/g, ' ').trim(),
  };
}

console.log(JSON.stringify({
  csrfStatus: csrfResp.status,
  csrfTokenPresent: Boolean(csrfToken),
  cookiePresent: Boolean(csrfCookie),
  remainingStatus: remainingResp.status,
  remainingSample: remainingBody.replace(/\s+/g, ' ').trim(),
  postStatus: postResp.status,
  postContentType: postResp.headers.get('content-type'),
  taskId,
  bodySample: body.replace(/\s+/g, ' ').trim(),
  status,
}, null, 2));
