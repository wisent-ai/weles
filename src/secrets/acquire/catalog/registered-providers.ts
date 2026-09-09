// The credentials someone sat down and enumerated, and every spelling a caller
// may reach them by.
//
// Each entry is a disclosure as much as a definition: the endpoints, the usage
// sentence, the scopes and the expected daily volume are what the provider's own
// sign-up form asks for, and the browser job repeats them verbatim. Editing one
// provider's disclosure is editing what Wisent tells that provider, which is a
// different act from changing how any credential is queued, so it lives apart
// from the queueing code.
//
// SECRET_REGISTRY is the alias table, not a second source of truth: every key
// resolves to one of the four objects above it, so a caller writing
// `s2_api_key`, `semantic_scholar` or the dotted item id lands on the same
// disclosure.

import type { SecretDefinition } from '../catalog.js';

export const SEMANTIC_SCHOLAR: SecretDefinition = {
  secret: 'semantic_scholar.api_key',
  provider: 'semantic_scholar',
  displayName: 'Semantic Scholar',
  envVars: ['SEMANTIC_SCHOLAR_API_KEY', 'S2_API_KEY'],
  defaultPurpose: 'lem',
  formUrl: 'https://www.semanticscholar.org/product/api#api-key-form',
  flowName: 'semantic-scholar-api-key-request',
  endpoints: ['/graph/v1/paper/search', '/graph/v1/paper/{paper_id}', '/graph/v1/author/search'],
  usageText: 'We use the Semantic Scholar Academic Graph API to retrieve paper metadata, abstracts, authors, venues, citation counts, identifiers, and related-paper signals for a local research-paper assistant. Requests are used for indexing and contextualizing academic papers selected by the user, not for bulk redistribution.',
  dailyRequests: '1000',
  requestedScopes: [],
  capabilities: ['paper_search', 'citation_metadata', 'related_papers'],
  runtimeInstall: true,
  headless: false,
  storeSecretTarget: 'skarbiec',
};

export const GITHUB_ADMIN_TOKEN: SecretDefinition = {
  secret: 'github.admin_org_token',
  provider: 'github',
  displayName: 'GitHub admin org token',
  envVars: ['PEOPLE_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
  defaultPurpose: 'people-router-lifecycle',
  formUrl: 'https://github.com/settings/tokens/new',
  flowName: 'github-admin-org-token-acquisition',
  endpoints: ['/user', '/orgs/{org}/memberships/{username}', '/orgs/{org}/teams/{team}/memberships/{username}'],
  usageText: 'We use a GitHub organization-admin token so people-router can administer employee organization and team membership during onboarding and offboarding (invite member, add/remove team membership, remove collaborator). The token must carry the admin:org scope. It is used only for lifecycle administration of the configured organization, not for repository content changes.',
  dailyRequests: '500',
  requestedScopes: ['admin:org', 'read:org'],
  capabilities: ['org_membership_admin', 'team_membership_admin'],
  runtimeInstall: true,
  headless: false,
  storeSecretTarget: 'skarbiec',
};
export const FIGMA_PERSONAL_ACCESS_TOKEN: SecretDefinition = {
  secret: 'figma.personal_access_token',
  provider: 'figma',
  displayName: 'Figma Personal Access Token',
  envVars: ['FIGMA_ACCESS_TOKEN'],
  defaultPurpose: 'design-assets-export',
  formUrl: 'https://www.figma.com/settings?tab=security',
  flowName: 'figma-personal-access-token-acquisition',
  endpoints: ['/v1/me', '/v1/files/{file_key}', '/v1/images/{file_key}', '/v1/files/{file_key}/versions', '/v1/folders/{folder_id}/files'],
  usageText: 'We use the read-only Figma REST API to archive company design files, version metadata, published libraries, and rendered image assets in the Wisent design-assets repository. The token is stored directly in Skarbiec and is never returned in Weles results.',
  dailyRequests: '500',
  requestedScopes: [
    'current_user:read',
    'file_content:read',
    'file_metadata:read',
    'file_versions:read',
    'folders:read',
    'folder_metadata:read',
    'library_assets:read',
    'library_content:read',
    'team_library_content:read',
  ],
  capabilities: ['company_design_archive', 'file_content_export', 'asset_rendering', 'version_inventory'],
  runtimeInstall: false,
  headless: false,
  storeSecretTarget: 'skarbiec',
};


export const SNAPCHAT_SNAP_KIT_API_TOKEN: SecretDefinition = {
  secret: 'snapchat.snap_kit_api_token',
  provider: 'snapchat',
  displayName: 'Snapchat Snap Kit production API token',
  envVars: ['SNAPCHAT_SNAP_KIT_API_TOKEN'],
  defaultPurpose: 'snap-kit-api',
  formUrl: 'https://kit.snapchat.com/manage/',
  flowName: 'snapchat-snap-kit-api-token-acquisition',
  endpoints: ['Snap Kit production API'],
  usageText: 'We use the production Snap Kit API token to authenticate the configured Snap Kit integration. Reuse the existing organization and project when present. Create a project only when none exists, and generate the production API token without exposing it in task results.',
  dailyRequests: '100',
  requestedScopes: [],
  capabilities: ['snap_kit_api'],
  runtimeInstall: true,
  headless: false,
  storeSecretTarget: 'skarbiec',
};

export const SECRET_REGISTRY: Record<string, SecretDefinition> = {
  [SEMANTIC_SCHOLAR.secret]: SEMANTIC_SCHOLAR,
  semantic_scholar_api_key: SEMANTIC_SCHOLAR,
  semantic_scholar: SEMANTIC_SCHOLAR,
  s2_api_key: SEMANTIC_SCHOLAR,
  [GITHUB_ADMIN_TOKEN.secret]: GITHUB_ADMIN_TOKEN,
  github_admin_org_token: GITHUB_ADMIN_TOKEN,
  github_admin_token: GITHUB_ADMIN_TOKEN,
  github_org_admin_token: GITHUB_ADMIN_TOKEN,
  [FIGMA_PERSONAL_ACCESS_TOKEN.secret]: FIGMA_PERSONAL_ACCESS_TOKEN,
  figma_personal_access_token: FIGMA_PERSONAL_ACCESS_TOKEN,
  figma_access_token: FIGMA_PERSONAL_ACCESS_TOKEN,
  figma_api_token: FIGMA_PERSONAL_ACCESS_TOKEN,
  [SNAPCHAT_SNAP_KIT_API_TOKEN.secret]: SNAPCHAT_SNAP_KIT_API_TOKEN,
  snapchat_snap_kit_api_token: SNAPCHAT_SNAP_KIT_API_TOKEN,
  snapchat_api_token: SNAPCHAT_SNAP_KIT_API_TOKEN,
};
