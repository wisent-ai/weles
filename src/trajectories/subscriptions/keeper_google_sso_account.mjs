// Drive an already-open keeper through Google SSO using a Weles service credential.
// This is for interactive keeper verification, not a one-shot trajectory.

import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getCredential } from '../../lib/service_credentials.mjs';

function parseArgs() {
  const out = {
    session: process.env.SESSION || '',
    credentialId: '',
    targetUrl: '',
  };
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (arg === '--session') out.session = process.argv[++i] || '';
    else if (arg === '--credential-id') out.credentialId = process.argv[++i] || '';
    else if (arg === '--target-url') out.targetUrl = process.argv[++i] || '';
    else throw new Error(`unknown arg: ${arg}`);
  }
  if (!out.session) throw new Error('missing --session or SESSION');
  if (!out.credentialId) throw new Error('missing --credential-id');
  return out;
}

function action(session, cmd) {
  const sock = join(homedir(), '.weles', 'keeper', session, 'socket');
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    let buf = '';
    conn.on('connect', () => conn.write(`${JSON.stringify(cmd)}\n`));
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      conn.end();
      try {
        const parsed = JSON.parse(line);
        if (!parsed.ok) reject(new Error(parsed.error || 'keeper action failed'));
        else resolve(parsed);
      } catch (error) {
        reject(error);
      }
    });
    conn.on('error', reject);
  });
}

async function text(session) {
  const res = await action(session, { action: 'eval', js: 'document.body.innerText.slice(0,5000)' });
  return String(res.result || '');
}

async function url(session) {
  const res = await action(session, { action: 'url' });
  return String(res.url || '');
}

async function clickText(session, textValue) {
  return action(session, {
    action: 'click',
    selector: `button:has-text("${textValue}"), [role="button"]:has-text("${textValue}"), a:has-text("${textValue}")`,
  });
}

async function clickFirstText(session, textValues) {
  let lastError = null;
  for (const textValue of textValues) {
    try {
      await clickText(session, textValue);
      return textValue;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`none clickable: ${textValues.join(', ')}`);
}

async function main() {
  const args = parseArgs();
  const credential = await getCredential(args.credentialId);
  if (!credential?.login_email || !credential?.login_password) {
    throw new Error(`credential ${args.credentialId} missing login_email/login_password`);
  }

  const steps = [];
  const mark = async (name) => {
    steps.push({ name, url: await url(args.session), text: (await text(args.session)).slice(0, 240) });
  };

  await mark('start');
  if ((await text(args.session)).includes('Email or phone')) {
    await action(args.session, {
      action: 'fill',
      selector: 'input[type="email"], input[name="identifier"], input#identifierId',
      text: credential.login_email,
    });
    await clickText(args.session, 'Next');
    await action(args.session, { action: 'humanidle', kind: 'deliberate' });
    await mark('email_submitted');
  }

  const afterEmailText = await text(args.session);
  if (/recaptcha|unusual traffic|verify it'?s you/i.test(afterEmailText)) {
    console.log(JSON.stringify({ ok: false, blocked: 'google_challenge_after_email', steps }, null, 2));
    process.exit(2);
  }

  if (!/password/i.test(afterEmailText) && /Try another way|Enter your password|Use your password/i.test(afterEmailText)) {
    if (/Enter your password/i.test(afterEmailText)) await clickText(args.session, 'Enter your password');
    else if (/Use your password/i.test(afterEmailText)) await clickText(args.session, 'Use your password');
    else await clickText(args.session, 'Try another way');
    await action(args.session, { action: 'humanidle', kind: 'deliberate' });
    await mark('password_option_clicked');
  }

  const beforePassword = await text(args.session);
  if (/password/i.test(beforePassword)) {
    await action(args.session, {
      action: 'fill',
      selector: 'input[type="password"], input[name="Passwd"]',
      text: credential.login_password,
    });
    await action(args.session, { action: 'press', key: 'Enter' });
    await action(args.session, { action: 'humanidle', kind: 'deliberate' });
    await mark('password_submitted');
  }

  for (let i = 0; i < 60; i += 1) {
    const current = await url(args.session);
    if (!current.includes('accounts.google.com')) break;
    await action(args.session, { action: 'humanidle', kind: 'short' });
  }

  const currentText = await text(args.session);
  if (/(Continue|Allow|Dalej|Kontynuuj|Zezwól|Zgadzam)/i.test(currentText) && (await url(args.session)).includes('accounts.google.com')) {
    try {
      const clicked = await clickFirstText(args.session, ['Continue', 'Allow', 'Dalej', 'Kontynuuj', 'Zezwól', 'Zgadzam']);
      await action(args.session, { action: 'humanidle', kind: 'deliberate' });
      await mark(`google_consent_${clicked}`);
    } catch {}
  }

  if (args.targetUrl) {
    await action(args.session, { action: 'nav', url: args.targetUrl });
    await action(args.session, { action: 'humanidle', kind: 'deliberate' });
    await mark('target_loaded');
  }

  console.log(JSON.stringify({
    ok: true,
    finalUrl: await url(args.session),
    finalText: (await text(args.session)).slice(0, 1000),
    steps,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
