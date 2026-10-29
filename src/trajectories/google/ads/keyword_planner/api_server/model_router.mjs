// The keyword intents come from the model, never from a list we keep. The call
// goes through Weles' one model client (`callJeden`): Brama with this
// workload's alias and signed identity, or the provider a user without Brama
// names in WELES_MODEL_ENDPOINT and WELES_MODEL. This module holds the two
// prompts (open the research, or judge whether the intents are already
// saturated) and the reading of the answer, which is one required call of
// KEYWORD_TOOL: its arguments are the answer, never JSON searched for in
// prose. A prompt carries only the facts the request stated; an absent one is
// left out rather than written as a placeholder.

import { callJeden } from '../../../../../../dist/agent/jeden.js';
import { normalizeKeyword } from './request_intake.mjs';

const KEYWORD_PROPERTIES = {
  saturated: {
    type: 'boolean',
    description:
      'true when every materially distinct paid-search intent is already covered',
  },
  keywords: {
    type: 'array',
    items: { type: 'string' },
    description:
      'one canonical Google Ads seed keyword per materially uncovered intent; empty when saturated',
  },
  rationale: {
    type: 'string',
    description:
      'the coverage plan, or why the intents are covered, or which intent is still missing',
  },
};

const KEYWORD_TOOL = {
  type: 'function',
  function: {
    name: 'answer_keyword_research',
    description: 'Answer the keyword research step.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: Object.keys(KEYWORD_PROPERTIES),
      properties: KEYWORD_PROPERTIES,
    },
  },
};

/** The answer the model gave as KEYWORD_TOOL's arguments; any other shape is the error, with the arguments. */
export function parseKeywordRouterResponse(raw) {
  if (typeof raw !== 'string')
    throw new Error(
      `model-router answered no arguments: ${JSON.stringify(raw)}`,
    );
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `model-router called ${KEYWORD_TOOL.function.name} with arguments that are not JSON: ${error.message}; arguments: ${raw}`,
    );
  }
  if (
    typeof parsed?.saturated !== 'boolean' ||
    !Array.isArray(parsed.keywords) ||
    !parsed.keywords.every((keyword) => typeof keyword === 'string') ||
    typeof parsed.rationale !== 'string'
  )
    throw new Error(
      `model-router called ${KEYWORD_TOOL.function.name} without saturated, keywords and rationale: ${raw}`,
    );
  return {
    saturated: parsed.saturated,
    keywords: [
      ...new Set(parsed.keywords.map(normalizeKeyword).filter(Boolean)),
    ],
    rationale: parsed.rationale,
  };
}

/** The request's stated facts, one line each; absent ones are left out. */
function requestFacts(input) {
  return [
    ['Subject', input.subject],
    ['Product', input.product],
    ['Niche', input.niche],
    ['Audience', input.audience],
    ['Landing page', input.landingPage],
    ['Goal', input.goal],
    ['Seed keywords', input.seedKeywords.join(', ')],
  ]
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}: ${value}`);
}

/** `state` is the research so far when the step judges saturation; without it the research opens. */
export async function generateKeywordsWithRouter(input, state) {
  const prompt = state
    ? [
        'Continue Google Ads keyword research by checking intent saturation.',
        'If all materially distinct paid-search intents are already covered, answer saturated true with no keywords.',
        'If coverage is incomplete, answer saturated false with one canonical Google Ads seed keyword for each materially uncovered intent, and say which intent is still missing.',
        'Do not include fixed counts, commentary, markdown, metrics, or near-duplicate variants of already checked intents.',
        'Avoid brands not present in the prompt and policy-sensitive/adult-explicit terms.',
        ...requestFacts(input),
        ...(state.checkedKeywords.length
          ? [`Already checked keywords: ${state.checkedKeywords.join(', ')}`]
          : []),
        `Metric rows found: ${JSON.stringify(
          state.rows.map((row) => ({
            keyword: row.keyword,
            avgMonthlySearches: row.avgMonthlySearches,
            competition: row.competition,
            yoyChange: row.yoyChange,
          })),
        )}`,
      ].join('\n')
    : [
        'Identify the materially distinct paid-search intents for this product.',
        'Answer saturated false with one canonical Google Ads seed keyword per distinct intent, and the coverage plan as the rationale.',
        'Do not include fixed counts, commentary, markdown, metrics, or near-duplicate long-tail variants.',
        ...requestFacts(input),
        'Prefer commercial-intent search phrases. Avoid brands not present in the prompt and policy-sensitive/adult-explicit terms.',
      ].join('\n');
  const routed = await callJeden(prompt, { tools: [KEYWORD_TOOL] });
  const parsed = parseKeywordRouterResponse(routed.raw);
  if (!parsed.saturated && !parsed.keywords.length)
    throw new Error(
      `model-router answered unsaturated research without a keyword: ${routed.raw}`,
    );
  return {
    ok: true,
    source: 'model-router',
    model: routed.model,
    routerHost: new URL(routed.routerUrl).host,
    saturated: parsed.saturated,
    keywords: parsed.keywords,
    rationale: parsed.rationale,
  };
}
