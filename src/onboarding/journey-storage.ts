// Where the first-use journey keeps its bundle, progress and pending events
// between runs: one directory of JSON files, each written whole and renamed
// into place, each checked for shape before it is believed.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  JourneyBundle,
  JourneyProgress,
  JourneyRuntimeEvent,
  JourneyStorage,
} from '../onboarding-runtime';

function storedProperty(value: unknown, field: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, field)?.value;
}

export function isStoredBundle(value: unknown): value is JourneyBundle {
  const storedDefinition = storedProperty(value, 'definition');
  const screens = storedProperty(storedDefinition, 'screens');
  return typeof storedProperty(value, 'journey_version_id') === 'string'
    && typeof storedProperty(value, 'canonical_definition') === 'string'
    && typeof storedProperty(value, 'content_sha256') === 'string'
    && typeof storedProperty(value, 'source_revision') === 'string'
    && storedProperty(storedDefinition, 'schema_version') === 1
    && typeof storedProperty(storedDefinition, 'product_id') === 'string'
    && typeof storedProperty(storedDefinition, 'journey_id') === 'string'
    && Array.isArray(screens)
    && screens.every((screen) => typeof storedProperty(screen, 'screen_id') === 'string'
      && Array.isArray(storedProperty(screen, 'actions'))
      && Array.isArray(storedProperty(screen, 'transitions')));
}

function isStoredProgress(value: unknown): value is JourneyProgress {
  const scopeKind = storedProperty(value, 'scope_kind');
  const status = storedProperty(value, 'status');
  const completedScreenIds = storedProperty(value, 'completed_screen_ids');
  const answers = storedProperty(value, 'answers');
  return typeof storedProperty(value, 'attempt_id') === 'string'
    && typeof storedProperty(value, 'product_id') === 'string'
    && typeof storedProperty(value, 'journey_version_id') === 'string'
    && typeof storedProperty(value, 'subject_hash') === 'string'
    && (scopeKind === 'user' || scopeKind === 'organization' || scopeKind === 'device' || scopeKind === 'workload')
    && typeof storedProperty(value, 'current_screen_id') === 'string'
    && Array.isArray(completedScreenIds)
    && completedScreenIds.every((screenId) => typeof screenId === 'string')
    && (status === 'in_progress' || status === 'skipped' || status === 'completed'
      || status === 'abandoned' || status === 'reset')
    && typeof storedProperty(value, 'evidence_revision') === 'string'
    && Array.isArray(answers);
}

function isStoredEvent(value: unknown): value is JourneyRuntimeEvent {
  const properties = storedProperty(value, 'properties');
  return typeof storedProperty(value, 'event_id') === 'string'
    && typeof storedProperty(value, 'event_name') === 'string'
    && typeof storedProperty(value, 'attempt_id') === 'string'
    && typeof storedProperty(value, 'product_id') === 'string'
    && typeof storedProperty(value, 'journey_version_id') === 'string'
    && typeof storedProperty(value, 'subject_hash') === 'string'
    && typeof storedProperty(value, 'screen_id') === 'string'
    && typeof storedProperty(value, 'occurred_at') === 'string'
    && typeof storedProperty(value, 'evidence_revision') === 'string'
    && properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    && Array.isArray(storedProperty(value, 'answers'));
}

export class FileJourneyStorage implements JourneyStorage {
  /**
   * @param surfaceIsPinned whether a stored bundle still describes the product
   *   surface this build renders; a bundle that does not is treated as absent.
   */
  constructor(
    private readonly directory: string,
    private readonly surfaceIsPinned: (bundle: JourneyBundle) => boolean,
  ) {}

  private bundlePath(productId: string, journeyId: string): string {
    return join(this.directory, `${productId}-${journeyId}-bundle.json`);
  }

  private progressPath(productId: string, journeyId: string, subjectHash: string): string {
    return join(this.directory, `${productId}-${journeyId}-${subjectHash}-progress.json`);
  }

  private eventsPath(): string {
    return join(this.directory, 'events.json');
  }

  private async load(path: string): Promise<unknown | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      return parsed;
    } catch {
      return null;
    }
  }

  private async save(path: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }

  async loadBundle(productId: string, journeyId: string): Promise<JourneyBundle | null> {
    const bundle = await this.load(this.bundlePath(productId, journeyId));
    return isStoredBundle(bundle) && this.surfaceIsPinned(bundle) ? bundle : null;
  }

  saveBundle(bundle: JourneyBundle): Promise<void> {
    return this.save(this.bundlePath(bundle.definition.product_id, bundle.definition.journey_id), bundle);
  }

  async loadProgress(productId: string, journeyId: string, subjectHash: string): Promise<JourneyProgress | null> {
    const progress = await this.load(this.progressPath(productId, journeyId, subjectHash));
    return isStoredProgress(progress) ? progress : null;
  }

  saveProgress(productId: string, journeyId: string, progress: JourneyProgress): Promise<void> {
    return this.save(this.progressPath(productId, journeyId, progress.subject_hash), progress);
  }

  async pendingEvents(): Promise<readonly JourneyRuntimeEvent[]> {
    const events = await this.load(this.eventsPath());
    return Array.isArray(events) ? events.filter(isStoredEvent) : [];
  }

  async appendEvent(event: JourneyRuntimeEvent): Promise<void> {
    const events = await this.pendingEvents();
    await this.save(this.eventsPath(), [...events.filter((entry) => entry.event_id !== event.event_id), event]);
  }

  async removeEvent(eventId: string): Promise<void> {
    const events = await this.pendingEvents();
    await this.save(this.eventsPath(), events.filter((entry) => entry.event_id !== eventId));
  }
}
