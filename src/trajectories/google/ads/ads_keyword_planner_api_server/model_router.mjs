// The keyword intents come from the model router, never from a list we keep.
// This module holds the Brama credentials and the per-request HMAC signature,
// the two prompts (open the research, or judge whether the intents are already
// saturated), and the reading of the JSON the model was asked to answer with.

import { createHash, createHmac } from 'node:crypto';
import { normalizeKeyword } from './request_intake.mjs';

let routerConfig = null;

export function loadModelRouterConfig() {
  if (routerConfig) return routerConfig;
  const routerUrl = String(process.env.STADO_MODEL_ROUTER_URL || '').trim().replace(/\/+$/, '');
  const routerToken = String(process.env.WELES_STADO_MODEL_ROUTER_TOKEN || '').trim();
  const agentId = String(process.env.WELES_STADO_MODEL_ROUTER_AGENT_ID || '').trim();
  const agentAuthSecret = String(process.env.WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET || '');
  if (!routerUrl) throw new Error('missing required STADO_MODEL_ROUTER_URL');
  if (!routerToken) throw new Error('missing required WELES_STADO_MODEL_ROUTER_TOKEN');
  if (!agentId) throw new Error('missing required WELES_STADO_MODEL_ROUTER_AGENT_ID');
  if (!agentAuthSecret) throw new Error('missing required WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET');
  if (agentAuthSecret.trim() !== agentAuthSecret || /\s/.test(agentAuthSecret)) {
    throw new Error('WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET must be one exact non-whitespace credential');
  }
  if (routerToken === agentAuthSecret) {
    throw new Error('keyword-planner Brama bearer and agent HMAC secret must be distinct');
  }
  routerConfig = {
    routerUrl,
    routerToken,
    agentId,
    agentAuthSecret,
    model: String(process.env.WELES_AGENT_MODEL || process.env.MODEL_ROUTER_MODEL || 'any').trim(),
    configId: 'stado-env',
  };
  return routerConfig;
}

function routerHeaders(cfg, body) {
  const timestamp = String(Date.now());
  const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
  const signature = createHmac('sha256', cfg.agentAuthSecret)
    .update(`${cfg.agentId}:${timestamp}:${bodyHash}`, 'utf8')
    .digest('hex');
  return {
    Authorization: `Bearer ${cfg.routerToken}`,
    'content-type': 'application/json',
    'x-agent-id': cfg.agentId,
    'x-agent-timestamp': timestamp,
    'x-agent-signature': signature,
  };
}

// Models wrap their JSON in prose or a code fence. The document is whatever sits
// between the first opening bracket of the outermost kind and its last closer,
// so an answer is read once, in one place, and is either that document or an
// error naming what came back instead.
function jsonDocument(text) {
  const brace = text.indexOf('{');
  const bracket = text.indexOf('[');
  const isArray = bracket >= 0 && (brace < 0 || bracket < brace);
  const open = isArray ? bracket : brace;
  const close = isArray ? text.lastIndexOf(']') : text.lastIndexOf('}');
  if (open < 0 || close <= open) return text;
  return text.slice(open, close + 1);
}

export function parseKeywordRouterResponse(raw) {
  const text = String(raw || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(jsonDocument(text));
  } catch (error) {
    throw new Error(`model-router did not answer with the keyword JSON shape: ${error?.message || error}; answer began: ${text.slice(0, 300)}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.keywords;
  if (!Array.isArray(list)) throw new Error(`model-router answer carried no keywords array: ${text.slice(0, 300)}`);
  return {
    saturated: Boolean(parsed.saturated),
    keywords: [...new Set(list.map(normalizeKeyword).filter(Boolean))],
    intents: Array.isArray(parsed.intents) ? parsed.intents : Array.isArray(parsed.clusters) ? parsed.clusters : [],
    rationale: typeof parsed.rationale === 'string' ? parsed.rationale : null,
  };
}

function readRouterCompletion(answer) {
  try {
    return JSON.parse(answer);
  } catch (error) {
    throw new Error(`model-router accepted the request but answered with a body that is not JSON: ${error?.message || error}; body began: ${answer.slice(0, 300)}`);
  }
}

export async function generateKeywordsWithRouter(input, state = null) {
  const cfg = loadModelRouterConfig();
  const prompt = state ? [
    'Continue Google Ads keyword research by checking intent saturation.',
    'Return ONLY valid JSON in this exact shape: {"saturated":true,"keywords":[],"rationale":"why"} or {"saturated":false,"keywords":["canonical keyword"],"rationale":"what intent is still missing"}.',
    'If all materially distinct paid-search intents are already covered, return saturated true and an empty keywords array.',
    'If coverage is incomplete, return one canonical Google Ads seed keyword for each materially uncovered intent.',
    'Do not include fixed counts, commentary, markdown, metrics, or near-duplicate variants of already checked intents.',
    'Avoid brands not present in the prompt and policy-sensitive/adult-explicit terms.',
    `Subject: ${input.subject || '(none)'}`,
    `Product: ${input.product || '(none)'}`,
    `Niche: ${input.niche || '(none)'}`,
    `Audience: ${input.audience || '(none)'}`,
    `Landing page: ${input.landingPage || '(none)'}`,
    `Goal: ${input.goal}`,
    `Seed keywords: ${input.seedKeywords.join(', ') || '(none)'}`,
    `Already checked keywords: ${state.checkedKeywords.join(', ') || '(none)'}`,
    `Metric rows found: ${JSON.stringify(state.rows.map((row) => ({
      keyword: row.keyword,
      avgMonthlySearches: row.avgMonthlySearches,
      competition: row.competition,
      yoyChange: row.yoyChange,
    })))}`,
  ].join('\n') : [
    'Identify the materially distinct paid-search intents for this product.',
    'Return ONLY valid JSON in this exact shape: {"saturated":false,"keywords":["canonical keyword"],"rationale":"coverage plan"}.',
    'Each keyword must be a canonical Google Ads seed keyword representing a different intent.',
    'Do not include fixed counts, commentary, markdown, metrics, or near-duplicate long-tail variants.',
    `Subject: ${input.subject || '(none)'}`,
    `Product: ${input.product || '(none)'}`,
    `Niche: ${input.niche || '(none)'}`,
    `Audience: ${input.audience || '(none)'}`,
    `Landing page: ${input.landingPage || '(none)'}`,
    `Goal: ${input.goal}`,
    `Seed keywords: ${input.seedKeywords.join(', ') || '(none)'}`,
    'Prefer commercial-intent search phrases. Avoid brands not present in the prompt and policy-sensitive/adult-explicit terms.',
  ].join('\n');
  const body = JSON.stringify({
    model: cfg.model,
    max_tokens: Number(process.env.WELES_KEYWORD_REPORT_MAX_TOKENS || 1400),
    messages: [{ role: 'user', content: prompt }],
  });
  const res = await fetch(`${cfg.routerUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: routerHeaders(cfg, body),
    body,
  });
  const answer = await res.text();
  if (!res.ok) throw new Error(`model-router ${res.status}: ${answer.slice(0, 500)}`);
  const data = readRouterCompletion(answer);
  const raw = data.choices?.[0]?.message?.content || '';
  const parsed = parseKeywordRouterResponse(raw);
  if (!parsed.saturated && !parsed.keywords.length) throw new Error(`model-router returned no parseable keywords: ${String(raw).slice(0, 300)}`);
  return {
    ok: true,
    source: 'model-router',
    model: data.model || cfg.model,
    routerHost: new URL(cfg.routerUrl).host,
    configId: cfg.configId,
    saturated: parsed.saturated,
    keywords: parsed.keywords,
    intents: parsed.intents,
    rationale: parsed.rationale,
  };
}
