// List Linear projects via the GraphQL API.
//
// Reads LINEAR_API_KEY from env, else first line of ~/.linear/token.
// Calls https://api.linear.app/graphql to fetch the first 50 projects with
// id, name, and a truncated description; prints one project per line.
//
// Also verifies get_api_key.mjs ("did the minted key actually work?") and
// serves as the lookup the Oko wip-summarize.mjs calls via oko/scripts/linear-helper.mjs.
//
// Run: node src/trajectories/linear/list_projects.mjs [name_filter]

import { readFileSync, existsSync } from 'node:fs';

const TOKEN_PATH = `${process.env.HOME}/.linear/token`;
const NAME_FILTER = process.argv[2] || '';

let apiKey = process.env.LINEAR_API_KEY || '';
if (!apiKey && existsSync(TOKEN_PATH)) {
  apiKey = readFileSync(TOKEN_PATH, 'utf8').trim().split('\n')[0];
}
if (!apiKey) {
  console.log(`FAIL: no LINEAR_API_KEY env and no ${TOKEN_PATH}; run get_api_key.mjs first`);
  process.exit(1);
}

const QUERY = `
  query Projects($filter: ProjectFilter) {
    projects(first: 50, filter: $filter) {
      nodes { id name description }
    }
  }
`;

const variables = {};
if (NAME_FILTER) variables.filter = { name: { eq: NAME_FILTER } };

const res = await fetch('https://api.linear.app/graphql', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    // Personal API keys use the raw key as Authorization (no "Bearer " prefix).
    'Authorization': apiKey,
  },
  body: JSON.stringify({ query: QUERY, variables }),
});

const body = await res.text();
if (!res.ok) {
  console.log(`FAIL: linear graphql HTTP ${res.status}: ${body.slice(0, 300)}`);
  process.exit(1);
}

let parsed;
try { parsed = JSON.parse(body); } catch {
  console.log(`FAIL: non-JSON response: ${body.slice(0, 300)}`);
  process.exit(1);
}
if (parsed.errors) {
  console.log(`FAIL: graphql errors: ${JSON.stringify(parsed.errors).slice(0, 400)}`);
  process.exit(1);
}

const nodes = parsed?.data?.projects?.nodes || [];
if (nodes.length === 0) {
  console.log(`(no projects matching ${NAME_FILTER ? `name="${NAME_FILTER}"` : 'first 50'})`);
  process.exit(0);
}

for (const p of nodes) {
  const desc = (p.description || '').replace(/\n/g, ' ').slice(0, 120);
  console.log(`${p.id}\t${p.name}\t${desc}`);
}
console.log(`PASS: ${nodes.length} project(s) listed`);
