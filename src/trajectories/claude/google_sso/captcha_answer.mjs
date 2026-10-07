// Answers the captcha claude.ai puts between Google's answer and its consent
// screen, with Weles' own solver (the services whose keys Skarbiec holds).
// The handoff loop reads the page again afterwards: a challenge that is gone
// moves the sign-in on, and one that comes back is answered again only after
// the page changed. A challenge Weles cannot read or no service answers ends
// the sign-in with a refusal naming the challenge, the services tried and
// what each part answered.
import { CaptchaSolver } from '../../../../dist/captcha/solver.js';
import { detectCaptcha, solvePageCaptcha } from '../../../../dist/captcha/detect.js';
import { dumpGisFailureDom } from './failure_dom.mjs';

const solver = new CaptchaSolver();

export async function answerClaudeCaptcha(active, views, variant) {
  const where = `${new URL(active.url()).host}${new URL(active.url()).pathname}`;
  const challenge = await detectCaptcha(active);
  const services = await solver.configuredServices();
  if (!challenge) {
    const dump = await dumpGisFailureDom(views, variant);
    const error = new Error(`gis_continue: claude.ai showed a challenge frame at ${where} that Weles' captcha detection does not read (no reCAPTCHA, Turnstile, hCaptcha or Arkose widget with a site key in any frame); add its kind to src/captcha/detect.ts; DOM snapshot: ${dump.written[0]?.path ?? dump.indexPath}`);
    error.code = 'provider_captcha_unreadable';
    throw error;
  }
  if (!services.some(Boolean)) {
    const error = new Error(`gis_continue: claude.ai asked for a ${challenge.type} challenge at ${where} and Weles holds no captcha-solving service key: Skarbiec has none of the Weles service secrets antiCaptcha, twoCaptcha, capSolver, capMonster, nopeCha or noCaptcha (field api_key)`);
    error.code = 'provider_captcha_no_solver';
    throw error;
  }
  console.log(`[google_sso] answering ${challenge.type} at ${where} through ${services.join(', ')}`);
  const solved = await solvePageCaptcha(active, solver);
  if (solved) return challenge.type;
  const dump = await dumpGisFailureDom(views, variant);
  const error = new Error(`gis_continue: claude.ai asked for a ${challenge.type} challenge (site key ${challenge.sitekey}) at ${where}; ${solved === null ? 'it was gone before it could be answered' : `none of ${services.join(', ')} returned a token the page accepted`}; the run log names each service's answer; DOM snapshot: ${dump.written[0]?.path ?? dump.indexPath}`);
  error.code = 'provider_captcha_unsolved';
  throw error;
}
