/**
 * Agent tool dispatch — delegates to WSession methods.
 * Every tool call goes through WSession, which provides automatic diagnostics
 * (screenshots, DOM snapshots, video) via its _action() wrapper.
 */

import type { WSession } from '../session/wsession.js';

export type ToolArgs = Record<string, any>;

export async function dispatch(session: WSession, tool: string, args: ToolArgs): Promise<string> {
  switch (tool) {
    case 'click':       return session.click(args.target ?? '');
    case 'fill':        return session.fill(args.target ?? '', args.value ?? '');
    case 'focus':       return session.focus(args.selector ?? '');
    case 'type_text':   return session.type(args.value ?? '');
    case 'press_key':   return session.press(args.key ?? 'Enter');
    case 'navigate':    return session.goto(args.url ?? '');
    case 'scroll':      return session.scroll(args.direction ?? 'down', args.amount ? Number(args.amount) : undefined);
    case 'wait':        return session.wait(Number(args.seconds ?? 1));
    case 'read':        return session.read(args.question ?? '');
    case 'select_option': return session.select(args.target ?? '', args.value ?? '');
    case 'set_control': return session.setControl(args.selector ?? '', args.value, args.checked);
    case 'js_click':    return session.jsClick(args.selector, args.text);
    case 'solve_captcha': return session.solveCaptcha();
    case 'check_email': return session.checkEmail(args.email ?? '', args.sender ?? '');
    case 'generate_identity': {
      if (session.identity) return 'generated identity already available as redacted $PLATFORM_NEW_* placeholders';
      const id = await session.generateIdentity(args.platform ?? 'reddit');
      return `generated identity available as redacted placeholders for ${args.platform ?? 'reddit'} username_hash=${id.username.length}:${id.username.slice(0, 2)}`;
    }
    case 'check_sms':   return session.checkSms(args.service ?? '', args.country ?? 'UK');
    case 'poll_sms_code': return session.pollSmsCode();
    case 'save_account': return session.saveAccount(args.platform ?? '', {
      username: args.username ?? '', email: args.email ?? '', password: args.password ?? '', name: args.name,
    });
    default: return `unknown tool: ${tool}`;
  }
}
