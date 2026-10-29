// GET /worker/version, GET /worker/status and POST /worker/<action>: what
// this deployment is and the resident task dispatcher's state, and the
// control of that dispatcher, token-authenticated. Recovery changes one
// durable queue, so concurrent control requests are refused.
import { constants as http } from 'node:http2';
import { json, requireTokenAuthorization } from '../../http-exchange.mjs';
import { createWorkerControl, workerActions } from '../../worker-control.mjs';

const CONTROL_ROUTE = /^\/worker\/(?<action>[^/]+)$/;

/** The worker control action `url` names on a POST, or null. */
function controlAction(req, url) {
  if (req.method !== 'POST') return null;
  const named = CONTROL_ROUTE.exec(url.pathname);
  if (!named || workerActions[named.groups.action] !== true) return null;
  return named.groups.action;
}

export function createWorkerRoutes(
  publicTaskService,
  buildDeploymentVersionValue,
) {
  const { controlWorker, workerStatus } =
    createWorkerControl(publicTaskService);
  let busy = false;

  async function control(req, res, action) {
    if (busy) {
      json(res, http.HTTP_STATUS_CONFLICT, {
        ok: false,
        error: 'worker_control_in_progress',
      });
      return;
    }
    busy = true;
    try {
      const out = await controlWorker(action);
      console.log(
        JSON.stringify({
          event: 'worker_control',
          action,
          ok: out.ok,
          changed: out.changed === true,
          remote: req.socket.remoteAddress,
          before: out.before,
          after: out.after,
        }),
      );
      if (out.ok) json(res, http.HTTP_STATUS_OK, out);
      else if (out.error === 'worker_busy')
        json(res, http.HTTP_STATUS_CONFLICT, out);
      else json(res, http.HTTP_STATUS_BAD_GATEWAY, out);
    } finally {
      busy = false;
    }
  }

  return {
    isWorkerRoute(req, url) {
      return (
        (req.method === 'GET' &&
          (url.pathname === '/worker/version' ||
            url.pathname === '/worker/status')) ||
        controlAction(req, url) !== null
      );
    },
    async respondToWorker(req, res, url) {
      if (!requireTokenAuthorization(req, res)) return;
      if (url.pathname === '/worker/version') {
        json(res, http.HTTP_STATUS_OK, {
          ok: true,
          identity: buildDeploymentVersionValue(),
        });
        return;
      }
      if (url.pathname === '/worker/status') {
        json(res, http.HTTP_STATUS_OK, {
          ok: true,
          worker: await workerStatus(),
        });
        return;
      }
      await control(req, res, controlAction(req, url));
    },
  };
}
