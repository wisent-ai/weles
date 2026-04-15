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
    case 'js_click':    return session.jsClick(args.selector, args.text);
    case 'solve_captcha': return session.solveCaptcha();
    case 'check_email': return session.checkEmail(args.email ?? '', args.sender ?? '');
    case 'generate_identity': {
      const id = await session.generateIdentity(args.platform ?? 'reddit');
      return `generated: username=${id.username} email=${id.email} name=${id.firstName} ${id.lastName}`;
    }
    case 'save_account': return session.saveAccount(args.platform ?? '', {
      username: args.username ?? '', email: args.email ?? '', password: args.password ?? '', name: args.name,
    });
    default: return `unknown tool: ${tool}`;
  }
}
