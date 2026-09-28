// Where the first-use journey keeps its bundle, progress and pending events
// between runs: one directory of JSON files, each written whole and renamed
// into place, each checked for shape before it is believed.
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rename, rm, truncate, writeFile } from 'node:fs/promises';
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

// Progress and the events it owes live in one record. Every write publishes a
// new numbered version (journal.<n>.json) with link(), which refuses an
// existing name atomically: two writers that read version n cannot both
// publish n+1, so the loser rereads and applies its change again. A version
// name is never freed: once n+1 is published, n is emptied to a zero-byte
// tombstone rather than deleted, so a writer that read n long ago still finds
// n+1 taken and cannot publish over a newer journal. Nothing is held between
// steps, so a crash leaves only an unpublished temporary file or an unemptied
// old version - never a lock that blocks the next run.
type Journal = { progress: Record<string, JourneyProgress>; events: JourneyRuntimeEvent[] };

const JOURNAL_VERSION = /^journal\.(\d+)\.json$/;
const LEGACY_EVENTS_FILE = 'events.json';
const LEGACY_PROGRESS_SUFFIX = '-progress.json';

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

  private journalPath(version: number): string {
    return join(this.directory, `journal.${version}.json`);
  }

  private async listing(): Promise<string[]> {
    return readdir(this.directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [] as string[];
      throw error;
    });
  }

  // The newest published journal and its version; version 0 is the state
  // before the first write, read from the separate progress files and
  // events.json earlier releases kept. An unreadable or malformed journal is
  // an error, never an empty one: treating it as empty would let the next
  // write erase its queue.
  private async readJournal(): Promise<{ journal: Journal; version: number }> {
    for (;;) {
      const names = await this.listing();
      const version = Math.max(0, ...names.map((name) => Number(JOURNAL_VERSION.exec(name)?.[1] ?? 0)));
      if (version === 0) return { journal: await this.readLegacy(names), version };
      const path = this.journalPath(version);
      let text: string;
      let stored: unknown;
      try {
        text = await readFile(path, 'utf8');
        stored = JSON.parse(text);
      } catch (error) {
        // Emptied between listing and reading because a newer version was
        // published: read that one. Anything else is this journal's fault.
        if (await this.superseded(version)) continue;
        throw error;
      }
      const progress = storedProperty(stored, 'progress');
      const events = storedProperty(stored, 'events');
      if (progress === null || typeof progress !== 'object' || Array.isArray(progress) || !Array.isArray(events)) {
        throw new Error(`${path} is not a journey journal (progress map and events list)`);
      }
      const entries = Object.entries(progress);
      const badProgress = entries.find(([, value]) => !isStoredProgress(value));
      if (badProgress) throw new Error(`${path}: progress ${badProgress[0]} is malformed`);
      const badEvent = events.findIndex((event) => !isStoredEvent(event));
      if (badEvent >= 0) throw new Error(`${path}: queued event ${badEvent} is malformed`);
      return { journal: { progress: Object.fromEntries(entries) as Record<string, JourneyProgress>, events }, version };
    }
  }

  private async superseded(version: number): Promise<boolean> {
    return (await this.listing()).some((name) => Number(JOURNAL_VERSION.exec(name)?.[1] ?? 0) > version);
  }

  private async readLegacy(names: string[]): Promise<Journal> {
    const journal: Journal = { progress: {}, events: [] };
    for (const name of names.filter((entry) => entry.endsWith(LEGACY_PROGRESS_SUFFIX))) {
      const progress = await this.load(join(this.directory, name));
      if (isStoredProgress(progress)) journal.progress[name.slice(0, -LEGACY_PROGRESS_SUFFIX.length)] = progress;
    }
    const events = await this.load(join(this.directory, LEGACY_EVENTS_FILE));
    if (Array.isArray(events)) journal.events = events.filter(isStoredEvent);
    return journal;
  }

  // Read, change and publish the next version; when another writer published
  // it first, start over from its journal so neither change is lost.
  private async withJournal<T>(change: (journal: Journal) => T): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (;;) {
      const { journal, version } = await this.readJournal();
      const result = change(journal);
      const temporary = join(this.directory, `journal.${process.pid}.${randomUUID()}.tmp`);
      await writeFile(temporary, `${JSON.stringify(journal)}\n`, { encoding: 'utf8', mode: 0o600 });
      try {
        await link(temporary, this.journalPath(version + 1));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        continue;
      } finally {
        await rm(temporary, { force: true });
      }
      if (version > 0) await truncate(this.journalPath(version), 0);
      return result;
    }
  }

  async loadBundle(productId: string, journeyId: string): Promise<JourneyBundle | null> {
    const bundle = await this.load(this.bundlePath(productId, journeyId));
    return isStoredBundle(bundle) && this.surfaceIsPinned(bundle) ? bundle : null;
  }

  saveBundle(bundle: JourneyBundle): Promise<void> {
    return this.save(this.bundlePath(bundle.definition.product_id, bundle.definition.journey_id), bundle);
  }

  async loadProgress(productId: string, journeyId: string, subjectHash: string): Promise<JourneyProgress | null> {
    const { journal } = await this.readJournal();
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
    return (await this.readJournal()).journal.events;
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
