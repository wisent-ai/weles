// `weles keeper start --session <id>`: one persistent Weles browser session
// that answers JSON commands on ~/.weles/keeper/<id>/socket, one command per
// line, one JSON answer per line. The keyword planner, the Google Ads TOTP
// activation, the NCBR audits and repairs, and the subscription collectors
// drive their session through this socket (src/trajectories/_shared/keeper/
// client.mjs). Every interaction goes through the humanized atoms; a command
// that fails answers { ok: false, error } with the failure, never a retry.
import net from 'node:net';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { WSession } from '../session/wsession.js';
import { humanFill, humanType } from '../human/keyboard.js';
import { humanClick, humanClickLocator, humanMove, humanScroll } from '../human/mouse.js';
import { UsageError } from './usage.js';
import type { ParsedCli } from '../cli.js';

type KeeperCommand = Record<string, unknown> & { action?: unknown };
type KeeperAnswer = Record<string, unknown> & { ok: boolean };

function text(cmd: KeeperCommand, key: string): string {
  const value = cmd[key];
  if (typeof value !== 'string' || !value) throw new Error(`${String(cmd.action)} needs a non-empty "${key}"`);
  return value;
}

function coordinate(cmd: KeeperCommand, key: string): number {
  const value = cmd[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${String(cmd.action)} needs a numeric "${key}"`);
  return value;
}

function visible(session: WSession, cmd: KeeperCommand) {
  const located = session.page.locator(text(cmd, 'selector'));
  return cmd.skipVisible === true ? located.first() : located.filter({ visible: true }).first();
}

export function keeperDirectory(session: string): string {
  return join(homedir(), '.weles', 'keeper', session);
}

export async function answerKeeperCommand(session: WSession, sessionName: string, cmd: KeeperCommand): Promise<KeeperAnswer> {
  switch (cmd.action) {
    case 'url':
      return { ok: true, url: session.page.url() };
    case 'nav':
      await session.page.goto(text(cmd, 'url'), { waitUntil: 'domcontentloaded' });
      return { ok: true, url: session.page.url() };
    case 'click':
      await humanClickLocator(session.page, visible(session, cmd));
      return { ok: true };
    case 'humanclick':
      await humanClick(session.page, coordinate(cmd, 'x'), coordinate(cmd, 'y'));
      return { ok: true };
    case 'humanmove':
      await humanMove(session.page, coordinate(cmd, 'x'), coordinate(cmd, 'y'));
      return { ok: true };
    case 'humanscroll':
      await humanScroll(session.page, coordinate(cmd, 'totalDeltaY'));
      return { ok: true };
    case 'fill':
      await humanFill(session.page, visible(session, cmd), text(cmd, 'text'));
      return { ok: true };
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
      const path = join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      await session.page.screenshot({ path });
      return { ok: true, path };
    }
    default:
      return { ok: false, error: `keeper ${sessionName} has no action ${JSON.stringify(cmd.action)}` };
  }
}

export async function runKeeper(parsed: ParsedCli): Promise<void> {
  if (parsed.positional.join(' ') !== 'start') throw new UsageError('keeper takes exactly: start --session <id> [--url <url>] [--headless]');
  const sessionName = parsed.options.session;
  if (typeof sessionName !== 'string' || !sessionName) throw new UsageError('keeper start needs --session <id>');
  const directory = keeperDirectory(sessionName);
  mkdirSync(directory, { recursive: true });
  const socket = join(directory, 'socket');
  if (existsSync(socket)) {
    throw new Error(`keeper ${sessionName} already has a socket at ${socket}; another keeper serves it, or the last one ended without removing it`);
  }

  const session = await WSession.start({ label: `keeper-${sessionName}`, headless: parsed.options.headless === true });
  const url = parsed.options.url;
  if (typeof url === 'string' && url) await session.page.goto(url, { waitUntil: 'domcontentloaded' });

  const server = net.createServer((connection) => {
    let buffer = '';
    connection.on('data', (chunk) => {
      buffer += chunk.toString();
      for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void (async () => {
          let answer: KeeperAnswer;
          try {
            answer = await answerKeeperCommand(session, sessionName, JSON.parse(line) as KeeperCommand);
          } catch (error) {
            answer = { ok: false, error: error instanceof Error ? error.message : String(error) };
          }
          if (!connection.destroyed) connection.write(`${JSON.stringify(answer)}\n`);
        })();
      }
    });
  });
  const removeSocket = () => { if (existsSync(socket)) unlinkSync(socket); };
  process.on('exit', removeSocket);
  session.page.on('close', () => {
    server.close();
    removeSocket();
    process.exit(0);
  });
  server.listen(socket, () => {
    process.stdout.write(`${JSON.stringify({ session: sessionName, socket, url: session.page.url() })}\n`);
  });
}
