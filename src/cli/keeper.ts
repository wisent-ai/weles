// `weles keeper start --session <id>`: one persistent Weles browser session
// that answers JSON commands on ~/.weles/keeper/<id>/socket, one command per
// line, one JSON answer per line. The keyword planner, the Google Ads TOTP
// activation, the NCBR audits and repairs, and the subscription collectors
// drive their session through this socket (src/trajectories/_shared/keeper/
// client.mjs). Every interaction goes through the humanized atoms; a command
// that fails answers { ok: false, error } with the failure, never a retry.
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WSession } from '../session/wsession.js';
import { humanFill, humanType } from '../human/keyboard.js';
import {
  humanClick,
  humanClickLocator,
  humanMove,
  humanScroll,
} from '../human/mouse.js';
import { UsageError } from './usage.js';
import { pageSettled } from '../browser/settled.js';
import type { ParsedCli } from '../cli.js';
import { serveKeeper } from './keeper/server.js';
import { keeperControl } from './keeper/client.js';

type KeeperCommand = Record<string, unknown> & { action?: unknown };
type KeeperAnswer = Record<string, unknown> & { ok: boolean };

function text(cmd: KeeperCommand, key: string): string {
  const value = cmd[key];
  if (typeof value !== 'string' || !value)
    throw new Error(`${String(cmd.action)} needs a non-empty "${key}"`);
  return value;
}

function coordinate(cmd: KeeperCommand, key: string): number {
  const value = cmd[key];
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${String(cmd.action)} needs a numeric "${key}"`);
  return value;
}

function visible(session: WSession, cmd: KeeperCommand) {
  const located = session.page.locator(text(cmd, 'selector'));
  return cmd.skipVisible === true
    ? located.first()
    : located.filter({ visible: true }).first();
}

export function keeperDirectory(session: string): string {
  return join(homedir(), '.weles', 'keeper', session);
}

export async function answerKeeperCommand(
  session: WSession,
  sessionName: string,
  cmd: KeeperCommand,
): Promise<KeeperAnswer> {
  switch (cmd.action) {
    case 'url':
      return { ok: true, url: session.page.url() };
    case 'settle':
      await pageSettled(session.page);
      return { ok: true, url: session.page.url() };
    case 'nav':
      await session.page.goto(text(cmd, 'url'), {
        waitUntil: 'domcontentloaded',
      });
      return { ok: true, url: session.page.url() };
    case 'click':
      await humanClickLocator(session.page, visible(session, cmd));
      return { ok: true };
    case 'humanclick':
      await humanClick(
        session.page,
        coordinate(cmd, 'x'),
        coordinate(cmd, 'y'),
      );
      return { ok: true };
    case 'humanmove':
      await humanMove(session.page, coordinate(cmd, 'x'), coordinate(cmd, 'y'));
      return { ok: true };
    case 'humanscroll':
      await humanScroll(session.page, coordinate(cmd, 'totalDeltaY'));
      return { ok: true };
    case 'fill': {
      if (typeof cmd.text !== 'string')
        throw new Error(
          'fill needs a string "text"; an empty string clears the field',
        );
      await humanFill(session.page, visible(session, cmd), cmd.text);
      return { ok: true };
    }
    case 'type':
      await humanType(session.page, text(cmd, 'text'));
      return { ok: true };
    case 'press':
      await session.page.keyboard.press(text(cmd, 'key'));
      return { ok: true };
    case 'eval':
      return { ok: true, result: await session.page.evaluate(text(cmd, 'js')) };
    case 'cookies':
      return { ok: true, cookies: await session.ctx.cookies() };
    case 'screenshot': {
      const directory = join(keeperDirectory(sessionName), 'screenshots');
      mkdirSync(directory, { recursive: true });
      const path = join(
        directory,
        `${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
      );
      await session.page.screenshot({ path });
      return { ok: true, path };
    }
    default:
      return {
        ok: false,
        error: `keeper ${sessionName} has no action ${JSON.stringify(cmd.action)}`,
      };
  }
}

export async function runKeeper(parsed: ParsedCli): Promise<void> {
  const verb = parsed.positional.join(' ');
  const sessionName = parsed.options.session;
  if (typeof sessionName !== 'string' || !sessionName)
    throw new UsageError(`keeper ${verb} needs --session <id>`);
  const directory = keeperDirectory(sessionName);
  const socket = join(directory, 'socket');
  switch (verb) {
    case 'status':
    case 'stop': {
      if (
        parsed.options.url !== undefined ||
        parsed.options.headless !== undefined
      )
        throw new UsageError(
          `keeper ${verb} does not start a browser; omit --url and --headless`,
        );
      let answer: unknown;
      if (verb === 'status' && !existsSync(socket))
        answer = { ok: true, session: sessionName, socket, state: 'stopped' };
      else answer = await keeperControl(socket, sessionName, verb);
      process.stdout.write(`${JSON.stringify(answer)}\n`);
      return;
    }
    case 'start':
      break;
    default:
      throw new UsageError('keeper takes start|status|stop --session <id>');
  }
  mkdirSync(directory, { recursive: true });
  if (existsSync(socket)) {
    throw new Error(
      `keeper ${sessionName} already has a socket at ${socket}; another keeper serves it, or the last one ended without removing it`,
    );
  }

  const session = await WSession.start({
    label: `keeper-${sessionName}`,
    headless: parsed.options.headless === true,
  });
  try {
    const url = parsed.options.url;
    if (typeof url === 'string' && url)
      await session.page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    await session.close();
    throw error;
  }
  await serveKeeper(session, sessionName, socket, (command) =>
    answerKeeperCommand(session, sessionName, command),
  );
}
