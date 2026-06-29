// Registry of Wisent apps/products that weles testing mode (run.mjs)
// smoke-checks. Add a product here and the runner picks it up - no runner
// edits needed.
//
//   name              short id used by --only and in the report
//   product           product family; multiple surfaces can map to one product
//   kind              app / landing / admin / creator / prototype / legacy
//   url               page to load
//   viewport          [width, height] the page is rendered at
//   requiresAuth      true => route only renders for a logged-in (and
//                     whitelisted) user; without a --storage session the
//                     runner reports SKIPPED_NEEDS_SESSION, never a fake pass
//   expectMinElements minimum rendered <body> element count to count as
//                     "rendered content" (blank shells fall below this)
export const TARGETS = [
  { name: 'content-platform', product: 'Content Platform', kind: 'admin', url: 'https://content.wisent.ai', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'wisent-app', product: 'Wisent AI', kind: 'app', url: 'https://app.wisent.ai', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'needher-ai', product: 'NeedHer AI', kind: 'app', url: 'https://www.needher.ai', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'wisent-app-com', product: 'Wisent AI', kind: 'app', url: 'https://wisent-app-com.vercel.app', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'wisent-enterprise', product: 'Wisent Enterprise', kind: 'admin', url: 'https://console.wisent.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'wisent-ai-landing', product: 'Wisent AI', kind: 'landing', url: 'https://www.wisent.ai', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'turbot-web', product: 'Turbot', kind: 'app', url: 'https://turbot.wisent.ai', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'oko-landing', product: 'Oko / Swiatowid', kind: 'landing', url: 'https://oko.wisent.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'weles-web', product: 'Weles', kind: 'app', url: 'https://weles.wisent.ai', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'singularity', product: 'Singularity / Wisent Trade', kind: 'app', url: 'https://singularity.wisent.ai', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'wisent-app-landing', product: 'Wisent AI', kind: 'landing', url: 'https://wisent-app.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'getwisent', product: 'Wisent AI', kind: 'legacy-landing', url: 'https://getwisent.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'aiwisent', product: 'Wisent AI', kind: 'legacy-landing', url: 'https://www.aiwisent.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'wisentplatform', product: 'Wisent Platform', kind: 'legacy-landing', url: 'https://www.wisentplatform.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'wisentai', product: 'Wisent AI', kind: 'legacy-landing', url: 'https://www.wisentai.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'trywisent', product: 'Wisent AI', kind: 'legacy-landing', url: 'https://www.trywisent.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'creators', product: 'Creators', kind: 'creator', url: 'https://creators.wisent.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'creator-portal', product: 'Creators', kind: 'creator', url: 'https://creator-portal-olive.vercel.app', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'alpha2', product: 'Alpha2', kind: 'landing', url: 'https://www.alpha2.ai', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'polacc', product: 'Polacc', kind: 'landing', url: 'https://www.pol-acc.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'singularity-web', product: 'Singularity / Wisent Trade', kind: 'legacy-app', url: 'https://singularity-web-my-team-c19efe71.vercel.app', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'pergamin-prototype', product: 'Pergamin', kind: 'prototype', url: 'https://pergamin-prototype.vercel.app', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'lukasz-site', product: 'Lukasz Bartoszcze', kind: 'personal-site', url: 'https://www.lukaszbartoszcze.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'app-wisent-deploy', product: 'Wisent AI', kind: 'legacy-app', url: 'https://app-wisent-deploy.vercel.app', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'wisent-landing-old', product: 'Wisent AI', kind: 'legacy-landing', url: 'https://wisent-landing.vercel.app', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'bobloo', product: 'Bobloo', kind: 'landing', url: 'https://www.bobloo.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'charlie-landing', product: 'Charlie', kind: 'legacy-landing', url: 'https://charlie-landing.vercel.app', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'real-landing', product: 'Real', kind: 'legacy-landing', url: 'https://real-landing.vercel.app', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'controlai-app', product: 'ControlAI', kind: 'app', url: 'https://app.controlai.org', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },
  { name: 'tourbot', product: 'Tourbot', kind: 'landing', url: 'https://www.tour-bot.com', viewport: [1280, 800], requiresAuth: false, expectMinElements: 20 },

  // Auth-gated deep routes. These are skipped unless --storage is provided.
  { name: 'app-home', product: 'Wisent AI', kind: 'auth-app-route', url: 'https://app.wisent.com/home', viewport: [1280, 800], requiresAuth: true, expectMinElements: 30 },
  { name: 'app-trading', product: 'Wisent AI', kind: 'auth-app-route', url: 'https://app.wisent.com/assistants/trading', viewport: [1280, 800], requiresAuth: true, expectMinElements: 30 },
];
