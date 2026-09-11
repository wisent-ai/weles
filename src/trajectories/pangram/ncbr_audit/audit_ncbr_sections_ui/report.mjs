// The markdown report of one audit run.
import { basename } from 'node:path';

export function markdownReport(report) {
  const lines = [];
  lines.push('# Pangram UI audit: NCBR STEP Path A and Path B');
  lines.push('');
  lines.push(`Run: \`${report.runId}\``);
  lines.push(`Generated: \`${report.generatedAt}\``);
  lines.push('');
  lines.push('Rules: Pangram UI trajectory only; `WELES_CAPTURE_RESPONSE_BODIES=0`; non-UI outputs rejected.');
  lines.push('');
  lines.push('| Path | Section | Part | Status | Verdict | AI % | Human % | Words | Source |');
  lines.push('|---|---:|---:|---|---|---:|---:|---:|---|');
  for (const r of report.results) {
    lines.push(`| ${r.path} | ${r.id} | ${r.part_count > 1 ? `${r.part}/${r.part_count}` : ''} | ${r.status}${r.reused ? ' reused' : ''} | ${r.verdict ?? ''} | ${r.ai_percent ?? ''} | ${r.human_percent ?? ''} | ${r.words ?? 0} | ${r.source_file ? basename(r.source_file) : ''} |`);
  }
  lines.push('');
  const ai = report.results.filter((r) => r.verdict === 'ai_generated');
  if (ai.length) {
    lines.push('## AI-generated flags');
    for (const r of ai) lines.push(`- ${r.path} ${r.id}: ${r.title} (${r.ai_percent}% AI)`);
    lines.push('');
  }
  const skipped = report.results.filter((r) => r.status !== 'checked' && r.status !== 'reused');
  if (skipped.length) {
    lines.push('## Not checked');
    for (const r of skipped) lines.push(`- ${r.path} ${r.id}: ${r.status}${r.note ? ` - ${r.note}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
