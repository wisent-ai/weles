// Queueing the creation of a credential that does not exist yet.
//
// This is the path where a browser job signs up, fills a provider's form and
// generates a key, so the only thing that must be true beforehand is that the
// result has somewhere safe to land and something to be traced to: a scoped
// Skarbiec writer for exactly this item, and one exact request id that becomes
// the trajectory build id. It refuses on nothing else, because everything the
// provider asks for is discovered by the worker, not by the caller.
//
// A dry run returns before either gate. It is a description of the job, not an
// attempt at it, and it is deliberately built from the same payload the real
// enqueue would use so the two can never drift.
//
// The vault item id is read back out of the assembled constraints rather than
// re-derived, because the Skarbiec contract — not this file — decides which item
// a credential is written to.

import { hasWelesAcquiredSecretWriter } from '../scoped-service.js';
import type { AcquireSecretRequest, AcquireSecretResult } from './request.js';
import type { SecretDefinition } from './catalog.js';
import { paramsFor, queueAction } from './queued-job.js';

export async function queueAcquisition(def: SecretDefinition, request: AcquireSecretRequest): Promise<AcquireSecretResult> {
  const params = paramsFor(def, request);
  let vaultItemId: string | undefined;
  if (params.constraints && typeof params.constraints === 'object' && !Array.isArray(params.constraints)) {
    const constrainedItemId = (params.constraints as Record<string, unknown>).vault_item_id;
    if (typeof constrainedItemId === 'string') vaultItemId = constrainedItemId;
  }
  if (request.dryRun === true) {
    return {
      status: 'operation_plan',
      operation: 'acquire',
      secret: def.secret,
      vaultItemId: vaultItemId ?? def.secret,
      provider: def.provider,
      url: def.formUrl,
      objective: String(params.objective),
      params,
    };
  }

  const missing = [
    ...(!hasWelesAcquiredSecretWriter(def.secret, request.tenantId) ? [`scoped Skarbiec writer for ${def.secret}`] : []),
    ...(!/^[a-f0-9]{64}$/i.test(request.requestId ?? '') ? ['one exact credential operation request id'] : []),
  ];
  if (missing.length) {
    return {
      status: 'needs_configuration',
      secret: def.secret,
      vaultItemId: vaultItemId ?? def.secret,
      provider: def.provider,
      missing,
      message: `Cannot enqueue Weles acquisition without ${missing.join(', ')}`,
    };
  }

  const buildId = request.requestId!;
  const actionLogId = queueAction(
    'generic_keeper_task',
    '',
    { ...params, trajectory_build_id: buildId },
    request.priority ?? 10,
  );

  return {
    status: 'operation_queued',
    operation: 'acquire',
    secret: def.secret,
    provider: def.provider,
    buildId,
    actionLogId,
    action: 'generic_keeper_task',
    flowName: def.flowName,
    ...(vaultItemId ? { vaultItemId } : {}),
    message: `${def.displayName} API key acquisition queued via generic_keeper_task`,
  };
}
