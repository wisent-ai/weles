// Buy one Claude account for Brama's pool: create it on a fresh identity,
// record it in the vault, pay for the plan Brama names, and sign it in for
// Brama in the same browser session.
//
// Brama asks for this through POST /subscriptions/acquire with the
// subscription id it chose (BRAMA_SUBSCRIPTION_ID) and the plan tier the
// pool's accounts hold (WELES_PLAN_TIER). The last stdout line is the
// verdict; a failure after the account was recorded or paid still says so,
// because a paid account the verdict does not name would be paid for twice.

import { WSession } from '../../../../dist/session/wsession.js';
import { selectLoginAccount } from '../../../../dist/utils/login-accounts.js';
import { bankAcquiredAccount } from '../../../../dist/utils/login-accounts/acquired.js';
import { requireCapabilities } from '../../_shared/auth/capabilities.mjs';
import { AuthenticationFailure } from '../../_shared/subscription-auth/oauth.mjs';
import {
  markStage as mark,
  reportFailure,
  signInWithin,
} from '../../_shared/subscription-auth/run.mjs';
import { buyPlan } from './checkout.mjs';
import { signUp } from './signup.mjs';

function required(name, meaning) {
  const value = process.env[name]?.trim();
  if (!value)
    throw new AuthenticationFailure(
      `${name.toLowerCase()}_required`,
      'identity',
      `${name} must name ${meaning}`,
    );
  return value;
}

const done = {};
try {
  mark('identity');
  const subscriptionId = required(
    'BRAMA_SUBSCRIPTION_ID',
    'the subscription id Brama chose for the account it buys',
  );
  const planTier = required(
    'WELES_PLAN_TIER',
    "the plan tier the pool's accounts hold",
  );
  requireCapabilities('claude/account/acquire');
  const session = await WSession.start({
    label: `acquire-${subscriptionId}`,
    browser: 'chromium',
    headless: false,
    platform: 'claude',
  });
  try {
    mark('browser_started');
    const identity = session.identity;
    done.account = identity.email;
    await signUp(session, identity, mark);
    const banked = bankAcquiredAccount({
      subscriptionId,
      provider: 'claude',
      bramaProvider: 'claude-code',
      email: identity.email,
      planTier,
    });
    done.login_item = banked.loginItem;
    done.subscription_item = banked.subscriptionItem;
    mark('account_banked');
    done.paid = await buyPlan(session, planTier, mark);
    const account = selectLoginAccount(
      'claude',
      banked.loginItem,
      subscriptionId,
    );
    await signInWithin('claude', account, session);
    process.stdout.write(
      `${JSON.stringify({ ok: true, subscription_id: subscriptionId, ...done })}\n`,
    );
  } finally {
    await session.close();
  }
} catch (error) {
  // What was already done travels with the failure: the account created,
  // the vault items written and the payment made are facts the caller must
  // not lose because a later step failed.
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      ...done,
      failure: {
        code: error.code,
        stage: error.stage,
        message: error.message,
      },
    })}\n`,
  );
  reportFailure(error, 'claude');
}
