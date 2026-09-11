// Oxylabs topup via Google GSI iframe + popup OAuth. Oxylabs uses plan-based
// billing: Starter($30/4GB), Basic($100/15GB), Standard($270/45GB), Advanced($500/100GB).
// TOPUP_USD is mapped to nearest plan; TOPUP_CONFIRM=1 proceeds to Stripe checkout.
import { WSession } from '../../../dist/session/wsession.js';
import { getScopedGoogleLogin } from '../_shared/services/google_sso.mjs';
import { topupOpts } from '../_shared/services/topup_common.mjs';
import { detectCurrentPlan, nearestPlan } from './topup/plans.mjs';
import { signInToDashboard } from './topup/sign_in.mjs';
import { topUpPayAsYouGo } from './topup/payg.mjs';
import { upgradeTier } from './topup/tier.mjs';

const { usd } = topupOpts();
const plan = nearestPlan(usd);
console.log(`[trajectory] requested $${usd}, using nearest plan: ${plan.name} ($${plan.price}/${plan.gb}GB)`);

const login = await getScopedGoogleLogin('oxylabsDashboard');
if (!login) { console.log('FAIL: no Google SSO creds'); process.exit(1); }

const s = await WSession.start({ label: 'oxylabs_topup', browser: 'chromium' });
try {
  await signInToDashboard(s, login);
  const { isPayAsYouGo, currentPlanName } = await detectCurrentPlan(s, plan);
  if (isPayAsYouGo) await topUpPayAsYouGo(s, usd);
  else await upgradeTier(s, plan, currentPlanName);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally { await s.close(); }
