import net from 'node:net';
import { existsSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { WSession } from '../../session/wsession.js';

type Command = Record<string, unknown> & { action?: unknown };
type Answer = Record<string, unknown> & { ok: boolean };

/** One browser owner, serialized actions, and terminal cleanup before stop replies. */
export async function serveKeeper(
  session: WSession,
  name: string,
  socket: string,
  dispatch: (command: Command) => Promise<Answer>,
): Promise<void> {
  const connections = new Set<net.Socket>();
  let currentAction: unknown = null;
  let stopping = false;
  let closing: Promise<void> | undefined;
  let queue = Promise.resolve();
  let ownsSocket = false;
  const {
    promise: done,
    resolve: resolveDone,
    reject: rejectDone,
  } = Promise.withResolvers<void>();
  const message = (error: unknown) =>
    error instanceof Error ? error.message : String(error);
  const status = () => ({
    ok: true,
    session: name,
    socket,
    state: stopping ? 'stopping' : 'running',
    action: currentAction,
    url: session.page.url(),
  });
  const reply = (connection: net.Socket, answer: Answer) => {
    if (!connection.destroyed && !connection.writableEnded)
      connection.write(`${JSON.stringify(answer)}\n`);
  };
  const server = net.createServer((connection) => {
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
    connection.on('error', (error) => {
      console.error(`keeper ${name} socket connection: ${message(error)}`);
      connection.destroy();
    });
    const lines = createInterface({ input: connection });
    connection.on('close', () => lines.close());
    lines.on('line', (line) => {
      let command: Command;
      try {
        command = JSON.parse(line);
        if (!command || typeof command !== 'object' || Array.isArray(command))
          throw new Error('keeper command must be a JSON object');
      } catch (error) {
        reply(connection, { ok: false, error: message(error) });
        return;
      }
      if (command.action === 'status') {
        reply(connection, status());
        return;
      }
      if (command.action === 'stop') {
        if (stopping)
          reply(connection, {
            ok: false,
            error: `keeper ${name} is already stopping`,
          });
        else void close(connection);
        return;
      }
      queue = queue.then(async () => {
        if (stopping) {
          reply(connection, {
            ok: false,
            error: `keeper ${name} is stopping; action not started`,
          });
          return;
        }
        currentAction = command.action;
        try {
          reply(connection, await dispatch(command));
        } catch (error) {
          reply(connection, { ok: false, error: message(error) });
        } finally {
          currentAction = null;
        }
      });
    });
  });
  function close(requestor?: net.Socket, cause?: unknown): Promise<void> {
    if (closing) return closing;
    stopping = true;
    closing = (async () => {
      const { promise: closed, resolve: resolveClosed } =
        Promise.withResolvers<void>();
      server.close(() => resolveClosed());
      let failure = cause;
      try {
        await session.close();
      } catch (error) {
        failure = error;
      }
      if (requestor && !requestor.destroyed) {
        const answer = failure
          ? {
              ok: false,
              session: name,
              state: 'failed',
              error: message(failure),
            }
          : { ok: true, session: name, state: 'stopped' };
        requestor.end(`${JSON.stringify(answer)}\n`, () => requestor.destroy());
      }
      for (const connection of connections) {
        if (connection !== requestor)
          connection.end(() => connection.destroy());
      }
      await closed;
      if (ownsSocket && existsSync(socket)) unlinkSync(socket);
      if (failure) throw failure;
    })();
    closing.then(resolveDone, rejectDone);
    return closing;
  }
  const stop = () => {
    void close();
  };
  const crashed = () => {
    void close(undefined, new Error(`keeper ${name} page crashed`));
  };
  const failed = (error: Error) => {
    void close(undefined, error);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  session.page.on('close', stop);
  session.page.on('crash', crashed);
  server.on('error', failed);
  try {
    try {
      server.listen(socket, () => {
        ownsSocket = true;
        process.stdout.write(`${JSON.stringify(status())}\n`);
      });
    } catch (error) {
      void close(undefined, error);
    }
    await done;
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    session.page.off('close', stop);
    session.page.off('crash', crashed);
    server.off('error', failed);
  }
}
