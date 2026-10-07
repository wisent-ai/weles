// Signing in to Overleaf through Google SSO and settling on the dashboard;
// persisted cookies skip the SSO entirely.
import { overleafGoogleSignIn } from '../../_shared/services/overleaf_google_sign_in.mjs';
import { captureOverleafAuth } from './evidence.mjs';

export async function signInToOverleaf(s, sessionStore, login) {
  const { alreadySignedIn, url } = await overleafGoogleSignIn(s, login, {
    label: 'pull_github',
  });
  if (!alreadySignedIn && !/\/project(\?|$|\/)/.test(url)) {
    await s.goto('https://www.overleaf.com/project');
  }
  await captureOverleafAuth(
    sessionStore,
    s,
    alreadySignedIn ? 'already-authenticated' : 'post-sso',
  );
}
