// Which addresses a page route may reach.
//
// A caller names a public page; nothing it names, and nothing that page loads,
// may reach loopback, link-local, private or cloud-metadata space of the host
// Weles runs on. The target is admitted before a browser opens, and every
// request the context makes afterwards is judged again by hostname, so a page
// cannot redirect or script its way onto the host's own network. The address
// ranges are the ones browser-evidence runs are held to (publicAddresses),
// handed in by the entry point so this file never reaches into the release
// tree.

const PASS_THROUGH_SCHEMES = ['data:', 'blob:', 'about:'];

export class PageTargetRefused extends Error {
  constructor(message) {
    super(message);
    this.name = 'PageTargetRefused';
  }
}

/** The caller's target as a URL, or a refusal naming why it is not public. */
export async function admitPublicTarget(raw, publicAddresses) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new PageTargetRefused(`not a URL: ${String(raw)}`);
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new PageTargetRefused(
      'only credential-free HTTPS URLs on the default port are served',
    );
  }
  try {
    await publicAddresses(url.hostname);
  } catch (error) {
    throw new PageTargetRefused(error.message);
  }
  url.hash = '';
  return url;
}

/**
 * Installs the per-request judgement on a browser context: every http(s)
 * request goes to a public HTTPS host or is aborted, and each hostname is
 * resolved once per context. Returns the list of refused requests so the
 * answer can say what the page was not allowed to load.
 */
export async function guardContext(context, publicAddresses) {
  const verdicts = new Map();
  const refused = [];
  await context.route('**/*', async (route) => {
    const raw = route.request().url();
    if (PASS_THROUGH_SCHEMES.some((scheme) => raw.startsWith(scheme))) {
      await route.continue();
      return;
    }
    try {
      const url = new URL(raw);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port
      ) {
        throw new Error('not public HTTPS');
      }
      let verdict = verdicts.get(url.hostname);
      if (!verdict) {
        verdict = publicAddresses(url.hostname).then(() => undefined);
        verdicts.set(url.hostname, verdict);
      }
      await verdict;
      await route.continue();
    } catch (error) {
      refused.push({
        url: raw,
        reason: String(error?.message || error),
      });
      await route.abort('blockedbyclient');
    }
  });
  return refused;
}
