import { constants as HTTP } from 'node:http2';
import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { keeperRequest } from '../../../../trajectories/_shared/keeper/client.mjs';
import { json, requireTokenAuthorization } from '../../http-exchange.mjs';

const root = join(homedir(), '.weles', 'keeper');

export function isKeeperRoute(path) {
  return path === '/keepers' || path.startsWith('/keepers/');
}

async function command(session, action) {
  if (
    !session ||
    basename(session) !== session ||
    session === '.' ||
    session === '..'
  ) {
    throw new Error('keeper session must name one directory, not a path');
  }
  const directory = join(root, session);
  const socket = join(directory, 'socket');
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(
        `keeper ${session} directory is not an owned session directory`,
      );
    }
    const infoSocket = await lstat(socket);
    if (!infoSocket.isSocket())
      throw new Error(`keeper ${session} control path is not a socket`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      switch (action) {
        case 'status':
          return { ok: true, session, socket, state: 'stopped' };
        default:
          throw error;
      }
    }
    throw error;
  }
  const answer = await keeperRequest(socket, { action });
  if (!answer || answer.ok !== true) {
    throw new Error(
      `keeper ${session} ${action} refused: ${JSON.stringify(answer)}`,
    );
  }
  if (answer.session !== session) {
    throw new Error(
      `keeper ${action} at ${socket} answered for another session`,
    );
  }
  return answer;
}

async function list() {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        try {
          return await command(entry.name, 'status');
        } catch (error) {
          return { ok: false, session: entry.name, error: error.message };
        }
      }),
  );
}

export async function respondToKeeper(req, res, url) {
  if (!requireTokenAuthorization(req, res)) return;
  const match = /^\/keepers\/(?<session>[^/]+)(?<stop>\/stop)?$/.exec(
    url.pathname,
  );
  try {
    switch (req.method) {
      case 'GET': {
        if (url.pathname === '/keepers') {
          json(res, HTTP.HTTP_STATUS_OK, { ok: true, keepers: await list() });
          return;
        }
        if (match && !match.groups.stop) {
          json(
            res,
            HTTP.HTTP_STATUS_OK,
            await command(decodeURIComponent(match.groups.session), 'status'),
          );
          return;
        }
        break;
      }
      case 'POST': {
        if (match?.groups.stop === '/stop') {
          json(
            res,
            HTTP.HTTP_STATUS_OK,
            await command(decodeURIComponent(match.groups.session), 'stop'),
          );
          return;
        }
        break;
      }
    }
    json(res, HTTP.HTTP_STATUS_METHOD_NOT_ALLOWED, {
      ok: false,
      error:
        'keeper route requires GET /keepers, GET /keepers/<session> or POST /keepers/<session>/stop',
    });
  } catch (error) {
    json(res, HTTP.HTTP_STATUS_BAD_GATEWAY, {
      ok: false,
      error: `keeper lifecycle: ${error.message}`,
    });
  }
}
