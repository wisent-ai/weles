// Sidecar driver for the weles-backed keeper. Talks to the keeper's Unix
// socket; keeper executes the command via humanized atoms in-process.
//
// Env: SESSION (default "default")
// Usage:
//   SESSION=linkedin node action.mjs screenshot
//   SESSION=linkedin node action.mjs dump
//   SESSION=linkedin node action.mjs url
//   SESSION=linkedin node action.mjs nav https://www.linkedin.com/feed/
//   SESSION=linkedin node action.mjs click 'button[aria-label="Sign in"]'
//   SESSION=linkedin node action.mjs fill 'input#username' 'user@host.com'
//   SESSION=linkedin node action.mjs type 'hello world'
//   SESSION=linkedin node action.mjs press Enter
//   SESSION=linkedin node action.mjs eval 'document.title'
//   SESSION=linkedin node action.mjs cookies

import net from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SESSION = process.env.SESSION || 'default';
const SOCK = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
const [, , action, ...args] = process.argv;
if (!action) { console.error('usage: action.mjs <action> [args]'); process.exit(1); }

let cmd;
switch (action) {
  case 'screenshot': case 'dump': case 'url': case 'cookies':
    cmd = { action }; break;
  case 'api_post':
    cmd = { action, url: args[0], body: args.slice(1).join(' ') }; break;
  case 'set_input_files':
    cmd = { action, selector: args[0], path: args[1] }; break;
  case 'nav':   cmd = { action, url: args[0] }; break;
  case 'click': cmd = { action, selector: args.join(' ') }; break;
  case 'click_any': cmd = { action: 'click', selector: args.join(' '), skipVisible: true }; break;
  case 'iframe_click': cmd = { action, iframe: args[0], selector: args.slice(1).join(' ') }; break;
  case 'ctx_pages': cmd = { action }; break;
  case 'all_pages': cmd = { action }; break;
  case 'switch_page': cmd = { action, index: parseInt(args[0], 10) }; break;
  case 'switch_to_url': cmd = { action, urlPattern: args.join(' ') }; break;
  case 'humanclick': cmd = { action, x: parseFloat(args[0]), y: parseFloat(args[1]) }; break;
  case 'humanscroll': cmd = { action, totalDeltaY: parseFloat(args[0] || '1200'), bursts: parseFloat(args[1] || '3') }; break;
  case 'humanmove': cmd = { action, x: parseFloat(args[0]), y: parseFloat(args[1]) }; break;
  case 'humanidle': cmd = { action, kind: args[0] || 'deliberate' }; break;
  case 'humanfill_email_password': cmd = { action, email: args[0], password: args.slice(1).join(' ') }; break;
  case 'click_signin_submit': cmd = { action }; break;
  case 'iframes': cmd = { action }; break;
  case 'fill':  cmd = { action, selector: args[0], text: args.slice(1).join(' ') }; break;
  case 'fill_any': cmd = { action: 'fill', selector: args[0], text: args.slice(1).join(' '), skipVisible: true }; break;
  case 'type':  cmd = { action, text: args.join(' ') }; break;
  case 'press': cmd = { action, key: args[0] }; break;
  case 'eval':  cmd = { action, js: args.join(' ') }; break;
  case 'solverecaptcha': cmd = { action }; break;
  case 'solvecaptcha': cmd = { action }; break;
  case 'save_account':
    cmd = { action, platform: args[0], username: args[1], email: args[2], password: args[3], name: args[4], status: args[5] };
    break;
  case 'mark_failed':
    cmd = { action, signal: args[0] || 'keeper_marked_failed', reason: args.slice(1).join(' ') || null };
    break;
  case 'fill_stripe': cmd = { action }; break;
  default: console.error(`unknown action: ${action}`); process.exit(1);
}

const conn = net.createConnection(SOCK);
let buf = '';
conn.on('connect', () => conn.write(JSON.stringify(cmd) + '\n'));
conn.on('data', (chunk) => {
  buf += chunk.toString();
  const nl = buf.indexOf('\n');
  if (nl < 0) return;
  const line = buf.slice(0, nl);
  try {
    const res = JSON.parse(line);
    console.log(JSON.stringify(res));
    conn.end();
    process.exit(res.ok ? 0 : 1);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
});
conn.on('error', (e) => {
  if (e.code === 'ECONNREFUSED' && existsSync(SOCK)) {
    try { unlinkSync(SOCK); } catch {}
  }
  console.error(`[action:${SESSION}] socket err: ${e.message}`);
  process.exit(2);
});
