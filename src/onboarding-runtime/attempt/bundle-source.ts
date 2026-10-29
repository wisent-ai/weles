// Which journey definition an attempt runs: the control plane's, else the
// last one stored on this device, else the definition shipped with the
// product. Each step down is recorded with the error that forced it, so the
// attempt can say which definition it ran and why.
import type { JourneyBundle } from '../types';
import type { JourneyStorage, JourneyTransport } from '../plane/contracts';
import { validateJourneyBundle } from '../journey/bundle';

/** Why an attempt is not running on the control plane's current state: one sentence per step it fell back. */
export type Degradation = readonly string[];

/** The bundle an attempt runs and the steps down it took to get it. */
export type LoadedBundle = {
  bundle: JourneyBundle;
  source: 'control_plane' | 'stored' | 'bundled';
  degraded: Degradation;
};

function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The journey's bundle from the first source that answers a valid one. */
export async function loadJourneyBundle(input: {
  productId: string;
  journeyId: string;
  transport: JourneyTransport;
  storage: JourneyStorage;
  canonicalFallback: JourneyBundle;
}): Promise<LoadedBundle> {
  const { productId, journeyId, transport, storage, canonicalFallback } = input;
  const degraded: string[] = [];
  const read = await transport
    .readBundle(productId, journeyId)
    .then(
      (answered) => validateJourneyBundle(answered, productId, journeyId),
      (error: unknown) => {
        degraded.push(
          `the control plane's journey ${journeyId} could not be read: ${causeOf(error)}`,
        );
        return null;
      },
    )
    .catch((error: unknown) => {
      degraded.push(
        `the control plane answered an invalid journey ${journeyId}: ${causeOf(error)}`,
      );
      return null;
    });
  if (read) {
    // A bundle that is valid but could not be kept is still run; the next offline start lacks it.
    await storage.saveBundle(read).catch((error: unknown) => {
      degraded.push(
        `journey ${journeyId} was read but not stored for offline use: ${causeOf(error)}`,
      );
    });
    return { bundle: read, source: 'control_plane', degraded };
  }

  const cached = await storage.loadBundle(productId, journeyId);
  if (cached) {
    const stored = await validateJourneyBundle(
      cached,
      productId,
      journeyId,
    ).catch((error: unknown) => {
      degraded.push(
        `the stored journey ${journeyId} is invalid: ${causeOf(error)}`,
      );
      return null;
    });
    if (stored) return { bundle: stored, source: 'stored', degraded };
  } else {
    degraded.push(`no journey ${journeyId} is stored on this device`);
  }

  const bundled = await validateJourneyBundle(
    canonicalFallback,
    productId,
    journeyId,
  );
  return { bundle: bundled, source: 'bundled', degraded };
}
