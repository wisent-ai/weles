import { test } from 'node:test';
import * as assert from 'node:assert';

import {
  CREDENTIAL_FIELD_ABSENT,
  wsFillCredential,
} from '../dist/session/wsession-helpers/finalize.js';
import type { WSession } from '../dist/session/wsession.js';

interface StubLocator {
  first(): { isVisible(): Promise<boolean> };
  count(): Promise<number>;
}

interface StubPage {
  url(): string;
  frames(): never[];
  mainFrame(): null;
  getByLabel(): StubLocator;
  locator(selector: string): StubLocator;
}

// A page whose only field is the one named. Google's identifier page is this
// shape: an email input, and no password input until the next page.
function pageWith(fieldsPresent: string[]): StubPage {
  const locator = (present: boolean): StubLocator => ({
    first: () => ({ isVisible: async () => present }),
    count: async () => (present ? 1 : 0),
  });
  return {
    url: () => 'https://accounts.google.com/v3/signin/identifier',
    frames: () => [],
    mainFrame: () => null,
    getByLabel: () => locator(false),
    locator: (selector: string) => locator(fieldsPresent.some((field) => selector.includes(field))),
  };
}

// The helper only ever touches `page`, and a stub is the whole point: a real
// session would need a browser and a capability broker to answer at all.
const sessionFor = (page: StubPage): WSession => ({ page }) as unknown as WSession;

const capability = {
  capability_id: 'a'.repeat(64),
  purpose: 'weles.browser.fill' as const,
  resource: 'origin:https://accounts.google.com/password',
  target: 'weles' as const,
};

test('a field that is not on the page declines the fill instead of spending the capability', async () => {
  const outcome = await wsFillCredential(sessionFor(pageWith(['email'])), 'Password field', 'password', capability);
  assert.equal(outcome, CREDENTIAL_FIELD_ABSENT);
});

test('a field that is on the page is not declined', async () => {
  // The email field exists, so this must get past the presence check and reach
  // redemption - which fails here for want of a broker, not for want of a field.
  await assert.rejects(
    () => wsFillCredential(sessionFor(pageWith(['email'])), 'Email or phone field', 'email', {
      ...capability,
      resource: 'origin:https://accounts.google.com/email',
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.notEqual(error.message, CREDENTIAL_FIELD_ABSENT);
      return true;
    },
  );
});
