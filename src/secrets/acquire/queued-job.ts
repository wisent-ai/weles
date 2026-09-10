// The one payload every acquisition path puts on the action queue, and the one
// call that puts it there.
//
// Both queueing paths — a managed password lifecycle and a fresh API-key
// acquisition — hand the worker the same shape, and a dry run returns exactly
// the payload the real run would have queued. Building it once here is what
// makes that promise true: a plan cannot describe a job the queue would not
// produce, because it is the same function.
//
// The constraints block is a contract with the bridge, not a bag of options.
// Which Skarbiec item and field may be written, which origin the credential may
// be captured on, and — for a directory identity — which tenant, principal and
// UPN the trajectory must re-prove are all pinned here, before anything runs.
//
// The objective sentences live one level down, in `queued-job/objective.ts`,
// because they are the only part of this payload a model interprets rather than
// a bridge parses.

import { acquiredSecretContract } from '../scoped-service.js';
import { enqueueAction } from '../../state/skarbiec-records.js';
import type { AcquireSecretRequest } from './request.js';
import { ENTRA_PROVIDER, type SecretDefinition } from './catalog.js';
import { objectiveFor, purposeFor } from './queued-job/objective.js';

export function paramsFor(def: SecretDefinition, request: AcquireSecretRequest): Record<string, unknown> {
  const autoPromote = request.autoPromoteTrajectory !== false;
  const accountEmail = request.accountEmail?.trim().toLowerCase()
    ?? request.goal?.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0]?.toLowerCase()
    ?? '';
  const contract = acquiredSecretContract(def.secret);
  if (!contract) throw new Error(`missing exact Skarbiec acquisition contract for ${def.secret}`);
  return {
    url: def.formUrl,
    objective: objectiveFor(def, request, accountEmail),
    flow_name: def.flowName,
    execution_mode: 'keeper_first',
    proxy: request.proxy ?? 'none',
    headless: request.headless ?? def.headless,
    auto_promote_trajectory: autoPromote,
    constraints: {
      secret: def.secret,
      operation: request.operation ?? 'acquire',
      request_id: request.requestId,
      purpose: purposeFor(request, def),
      account_email: accountEmail || undefined,
      store_secret_target: def.storeSecretTarget,
      vault_item_id: contract.item,
      vault_field: contract.field,
      // A registered item pins its source origin in the Skarbiec contract. A
      // generic item has none to pin, so the declared signup origin travels with
      // the job and the worker checks the capture page against exactly it.
      secret_source_origin: contract.sourceOrigin ?? def.sourceOrigin ?? '',
      // For microsoft_entra the directory block below is the only source of the
      // identity, so the flat binding tenant stays empty for that provider.
      tenant_id: def.provider === ENTRA_PROVIDER ? undefined : (request.tenantId ?? undefined),
      ...(def.provider === ENTRA_PROVIDER
        ? {
            // The directory identity is the item's own write-once contract, not a
            // call argument: the trajectory reads it from exactly this block. The
            // Entra directory id here is not a Weles Skarbiec binding tenant, so
            // the scoped reader and writer stay on the untenanted host binding.
            // Always these four keys: the block is a fixed-shape contract, so a
            // request without coordinates emits empty strings that fail closed at
            // the bridge rather than dropping keys JSON.stringify would erase.
            directory: {
              provider: ENTRA_PROVIDER,
              tenant_id: request.tenantId?.trim().toLowerCase() ?? '',
              principal_object_id: request.principalObjectId?.trim().toLowerCase() ?? '',
              account_upn: request.accountUpn?.trim().toLowerCase() ?? '',
            },
            weles_tenant_id: null,
          }
        : {}),
      display_name: def.displayName,
      env_var: def.envVars[0],
      env_vars: def.envVars,
      provider: def.provider,
      capabilities: def.capabilities,
      requested_scopes: def.requestedScopes,
      requested_endpoints: def.endpoints,
      expected_daily_requests: def.dailyRequests,
      runtime_install: def.runtimeInstall,
    },
    env: {},
  };
}

export function queueAction(action: string, accountItem: string, params: Record<string, unknown>, priority = 0): string {
  return enqueueAction(action, accountItem, { ...params, priority });
}
