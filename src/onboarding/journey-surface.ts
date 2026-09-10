// The first-use journey this build ships: its identity, the bundled
// definition and the offline fallback made from it, the screen copy, and
// the check that a bundle read from anywhere still describes this surface.
import { createHash } from 'node:crypto';
import journeyDefinition from './journeys/weles-first-use-2026-09-05.1.json';
import type { JourneyBundle, JourneyDefinition } from '../onboarding-runtime';

export const PRODUCT_ID = 'weles';
export const JOURNEY_ID = 'first-use';
export const JOURNEY_VERSION = '2026-09-05.1';
const JOURNEY_VERSION_ID = 'a707bb29-3848-4b1d-a868-84fc7ae3978e';
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;

export const definition = journeyDefinition as unknown as JourneyDefinition;
if (definition.product_id !== PRODUCT_ID
  || definition.journey_id !== JOURNEY_ID
  || definition.journey_version !== JOURNEY_VERSION
  || !SOURCE_REVISION_PATTERN.test(definition.source_revision)) {
  throw new Error('bundled Weles first-use journey identity is invalid');
}
export const SOURCE_REVISION = definition.source_revision;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

const canonicalDefinition = JSON.stringify(canonicalize(definition));
export const WELES_FIRST_USE_FALLBACK: JourneyBundle = {
  journey_version_id: JOURNEY_VERSION_ID,
  definition,
  canonical_definition: canonicalDefinition,
  content_sha256: createHash('sha256').update(canonicalDefinition).digest('hex'),
  source_revision: SOURCE_REVISION,
};

export const CONTENT: Readonly<Record<string, Readonly<{ title: string; body: string }>>> = {
  'authorization-boundary': {
    title: 'Confirm the authorization boundary',
    body: 'Weles executes only an already-authorized, allowlisted workflow. Possessing credentials does not authorize a new origin or action; organization, origin, action, credential references, justification, idempotency, and evidence policy must be admitted through the safe Weles client before this host runs anything.',
  },
  'existing-data': {
    title: 'Bring your existing Weles workflows',
    body: 'Optional: run weles onboarding import <trajectory-export.json> --host <managed-worker-hostname>. Weles validates the complete API export, preserves existing rows, and stores accepted definitions as host-bound drafts. It never starts a workflow, scans or copies a browser profile, or grants a new action. Run onboarding next to keep an empty usable setup.',
  },
  'host-execution': {
    title: 'Run on the approved Weles host',
    body: 'The scheduler owns task admission and terminal state, the supervised host runs the reviewed trajectory with deployment-selected browsers, and the secret boundary resolves only scoped credential references. Do not start browser automation from onboarding; submit the real approved workflow through @wisent-ai/weles-client and wait for its terminal service response.',
  },
  'receipt-verification': {
    title: 'Verify the real workflow receipt',
    body: 'Export the terminal service receipt and the trusted public-key map, then run: weles onboarding verify --receipt <receipt.json> --keys <receipt-keys.json>. Weles completes first use only after @wisent-ai/weles-client verifies the signature and bound task, organization, origin, action, outcome, and evidence digest.',
  },
};


export function hasPinnedProductSurface(bundle: JourneyBundle): boolean {
  const screenIds = bundle.definition.screens.map((screen) => screen.screen_id).sort();
  const expectedScreenIds = Object.keys(CONTENT).sort();
  const actionsMatch = bundle.definition.screens.every((screen) => {
    if (screen.screen_id === 'receipt-verification') {
      return screen.actions.length === 1 && screen.actions[0] === 'verify';
    }
    if (screen.screen_id === 'existing-data') {
      return screen.actions.length === 2 && screen.actions[0] === 'import' && screen.actions[1] === 'next';
    }
    return screen.actions.length === 1 && screen.actions[0] === 'next';
  });
  return bundle.definition.journey_version === JOURNEY_VERSION
    && bundle.definition.first_success_fact === 'authorized_browser_workflow_completed'
    && bundle.definition.entry_screen_id === definition.entry_screen_id
    && screenIds.length === expectedScreenIds.length
    && screenIds.every((screenId, index) => screenId === expectedScreenIds[index])
    && actionsMatch;
}
