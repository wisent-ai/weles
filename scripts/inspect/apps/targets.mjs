// Registry of Wisent apps/products that weles testing mode (run.mjs)
// smoke-checks. Add a product here and the runner picks it up — no runner
// edits needed.
//
//   name              short id used by --only and in the report
//   url               page to load
//   viewport          [width, height] the page is rendered at
//   requiresAuth      true => route only renders for a logged-in (and
//                     whitelisted) user; without a --storage session the
//                     runner reports SKIPPED_NEEDS_SESSION, never a fake pass
//   expectMinElements minimum rendered <body> element count to count as
//                     "rendered content" (blank shells fall below this)
export const TARGETS = [
  { name: 'wisent.ai', url: 'https://wisent.ai', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'getwisent', url: 'https://getwisent.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'trywisent', url: 'https://trywisent.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'aiwisent', url: 'https://aiwisent.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'app-home', url: 'https://app.wisent.com/home', viewport: [1280, 800], requiresAuth: true, expectMinElements: 30 },
  { name: 'app-trading', url: 'https://app.wisent.com/assistants/trading', viewport: [1280, 800], requiresAuth: true, expectMinElements: 30 },
];
