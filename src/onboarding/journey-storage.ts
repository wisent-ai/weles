// Where the first-use journey keeps its bundle, progress and pending events
// between runs: one directory of JSON files, each written whole and renamed
// into place, each checked for shape before it is believed.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
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

// Progress and the events it owes live in one record, published by one
// rename, so no crash or refused write can leave a step recorded without its
// events (or the reverse).
type Journal = { progress: Record<string, JourneyProgress>; events: JourneyRuntimeEvent[] };

const JOURNAL_FILE = 'journal.json';
const LEGACY_EVENTS_FILE = 'events.json';
const LEGACY_PROGRESS_SUFFIX = '-progress.json';

export class FileJourneyStorage implements JourneyStorage {
  // Every read-modify-write of the journal runs after the previous one, so a
  // stale copy of the queue can never overwrite events committed meanwhile.
  private chain: Promise<unknown> = Promise.resolve();

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

  private progressKey(productId: string, journeyId: string, subjectHash: string): string {
    return `${productId}-${journeyId}-${subjectHash}`;
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

  // The journal, or - before its first write - the separate progress files
  // and events.json earlier releases kept, which the first write replaces.
  private async readJournal(): Promise<Journal> {
    const stored = await this.load(join(this.directory, JOURNAL_FILE));
    if (stored !== null) {
      const progress = storedProperty(stored, 'progress');
      const events = storedProperty(stored, 'events');
      return {
        progress: Object.fromEntries(Object.entries(progress !== null && typeof progress === 'object' ? progress : {})
          .filter((entry): entry is [string, JourneyProgress] => isStoredProgress(entry[1]))),
        events: Array.isArray(events) ? events.filter(isStoredEvent) : [],
      };
    }
    const names = await readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    });
    const journal: Journal = { progress: {}, events: [] };
    for (const name of names.filter((entry) => entry.endsWith(LEGACY_PROGRESS_SUFFIX))) {
      const progress = await this.load(join(this.directory, name));
      if (isStoredProgress(progress)) journal.progress[name.slice(0, -LEGACY_PROGRESS_SUFFIX.length)] = progress;
    }
    const events = await this.load(join(this.directory, LEGACY_EVENTS_FILE));
    if (Array.isArray(events)) journal.events = events.filter(isStoredEvent);
    return journal;
  }

  private withJournal<T>(change: (journal: Journal) => T): Promise<T> {
    const run = this.chain.then(async () => {
      const journal = await this.readJournal();
      const result = change(journal);
      await this.save(join(this.directory, JOURNAL_FILE), journal);
      return result;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }

  async loadBundle(productId: string, journeyId: string): Promise<JourneyBundle | null> {
    const bundle = await this.load(this.bundlePath(productId, journeyId));
    return isStoredBundle(bundle) && this.surfaceIsPinned(bundle) ? bundle : null;
  }

  saveBundle(bundle: JourneyBundle): Promise<void> {
    return this.save(this.bundlePath(bundle.definition.product_id, bundle.definition.journey_id), bundle);
  }

  async loadProgress(productId: string, journeyId: string, subjectHash: string): Promise<JourneyProgress | null> {
    await this.chain;
    const journal = await this.readJournal();
    return journal.progress[this.progressKey(productId, journeyId, subjectHash)] ?? null;
  }

  commitProgress(
    productId: string,
    journeyId: string,
    progress: JourneyProgress,
    events: readonly JourneyRuntimeEvent[],
  ): Promise<void> {
    return this.withJournal((journal) => {
      journal.progress[this.progressKey(productId, journeyId, progress.subject_hash)] = progress;
      const known = new Set(journal.events.map((entry) => entry.event_id));
      journal.events.push(...events.filter((event) => !known.has(event.event_id)));
    });
  }

  async pendingEvents(): Promise<readonly JourneyRuntimeEvent[]> {
    await this.chain;
    return (await this.readJournal()).events;
  }

  appendEvent(event: JourneyRuntimeEvent): Promise<void> {
    return this.withJournal((journal) => {
      journal.events = [...journal.events.filter((entry) => entry.event_id !== event.event_id), event];
    });
  }

  removeEvent(eventId: string): Promise<void> {
    return this.withJournal((journal) => {
      journal.events = journal.events.filter((entry) => entry.event_id !== eventId);
    });
  }
}
