// How the first-use journey reaches Stado: refused outright when offline,
// and otherwise pinned to the journey version this build was made for.
import type {
  JourneyAssignment,
  JourneyAssignmentInput,
  JourneyBundle,
  JourneyRuntimeEvent,
  JourneyTransport,
} from '../onboarding-runtime';
import { isStoredBundle } from './journey-storage.js';

export class OfflineJourneyTransport implements JourneyTransport {
  async readBundle(): Promise<JourneyBundle> { throw new Error('Stado onboarding is offline'); }
  async readState(): Promise<null> { throw new Error('Stado onboarding is offline'); }
  async collectEvent(): Promise<void> { throw new Error('Stado onboarding is offline'); }
  async assignExperiment(_input: JourneyAssignmentInput): Promise<JourneyAssignment> {
    throw new Error('Stado onboarding is offline');
  }
}

export class VersionPinnedTransport implements JourneyTransport {
  constructor(
    private readonly transport: JourneyTransport,
    private readonly journeyVersion: string,
    private readonly surfaceIsPinned: (bundle: JourneyBundle) => boolean,
  ) {}

  async readBundle(productId: string, journeyId: string): Promise<JourneyBundle> {
    const bundle = await this.transport.readBundle(productId, journeyId, this.journeyVersion);
    if (!isStoredBundle(bundle) || !this.surfaceIsPinned(bundle)) {
      throw new Error('central Weles journey identity or product surface is invalid');
    }
    return bundle;
  }

  readState(productId: string, attemptId: string, subjectHash: string): Promise<unknown | null> {
    return this.transport.readState(productId, attemptId, subjectHash);
  }

  collectEvent(event: JourneyRuntimeEvent): Promise<void> {
    return this.transport.collectEvent(event);
  }

  assignExperiment(input: JourneyAssignmentInput): Promise<JourneyAssignment> {
    return this.transport.assignExperiment(input);
  }
}
