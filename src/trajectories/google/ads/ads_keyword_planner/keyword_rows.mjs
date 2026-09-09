// A visible table row, read as a keyword measurement.
//
// Moved verbatim out of the single keyword-planner file during a split by
// responsibility.

import { keywords, norm } from './request.mjs';

export function parseVolumeText(value) {
  const text = norm(value);
  const range = text.match(/\b(\d+(?:[,.]\d+)?\s*[KM]?)\s*(?:-|–|to)\s*(\d+(?:[,.]\d+)?\s*[KM]?)\b/i);
  if (range) return range[0].replace(/\s+/g, ' ');
  const number = text.match(/\b\d+(?:[,.]\d+)?\s*[KM]?\b/i);
  return number ? number[0].replace(/\s+/g, ' ') : null;
}

export function parseKeywordRows(rows) {
  const parsed = [];
  for (const row of rows.map(norm).filter(Boolean)) {
    const matchedKeyword = keywords.find((keyword) => row.toLowerCase().includes(keyword.toLowerCase()));
    if (!matchedKeyword) continue;
    const volume = parseVolumeText(row);
    const competition = row.match(/\b(Low|Medium|High)\b/i)?.[1] || null;
    const bidMentions = [...row.matchAll(/(?:US)?[$£€]\s?\d+(?:[,.]\d+)?/g)].map((match) => match[0]);
    parsed.push({
      keyword: matchedKeyword,
      averageMonthlySearchesText: volume,
      competition,
      bidMentions,
      raw: row,
    });
  }
  return parsed;
}
