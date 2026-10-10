// Turns two text previews of one LSI2 application into a correction-session plan.
//
//   node diff_plan.mjs <current-preview.txt> <target-preview.txt> > plan.json
//
// The current preview is the application as LSI2 holds it (the PDF preview
// LSI2 generates, as text); the target is the same text with the corrections
// written into it. Every changed run of lines becomes one edit {section, from,
// to}: the section is the last LSI2 section heading ("2.2. Opis ...",
// "7. ANALIZA RYZYKA") above the run in the current preview, `from` is the
// current text and `to` the target text, each with its preview line breaks
// joined by spaces. A run that only adds lines is anchored on the line before
// it, so the added text follows that line in the same field. Lines before the
// first section heading are the preview's header and produce no edit. What the
// session cannot find in any field (labels, option lists, computed summaries)
// it reports as unmatched; nothing here decides that for it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const [currentPath, targetPath] = process.argv.slice(2);
if (!currentPath || !targetPath) {
  process.stderr.write(
    'usage: node diff_plan.mjs <current-preview.txt> <target-preview.txt>\n',
  );
  process.exit(2);
}

const current = readFileSync(currentPath, 'utf8').split('\n');
const heading = /^(\d+\.\d+)\. \S|^(\d+)\. [A-ZĄĆĘŁŃÓŚŹŻ][A-ZĄĆĘŁŃÓŚŹŻ ,/+-]+$/;
const sectionAt = [];
let section = null;
for (const [index, line] of current.entries()) {
  const match = line.match(heading);
  if (match) section = match[1] || match[2];
  sectionAt[index + 1] = section;
}

let diff;
try {
  diff = execFileSync('diff', [currentPath, targetPath], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
} catch (error) {
  if (error.status !== 1) throw error;
  diff = error.stdout;
}

const join = (lines) => lines.join(' ').replace(/\s+/g, ' ').trim();
const edits = [];
const lines = diff.split('\n');
for (let index = 0; index < lines.length; index += 1) {
  const head = lines[index].match(/^(\d+)(?:,(\d+))?([acd])(\d+)(?:,(\d+))?$/);
  if (!head) continue;
  const start = Number(head[1]);
  const kind = head[3];
  const removed = [];
  const added = [];
  for (
    index += 1;
    index < lines.length && !/^\d/.test(lines[index]);
    index += 1
  ) {
    if (lines[index].startsWith('< ')) removed.push(lines[index].slice(2));
    else if (lines[index].startsWith('> ')) added.push(lines[index].slice(2));
  }
  index -= 1;
  const label = sectionAt[start];
  if (!label) continue;
  if (kind === 'a') {
    const anchor = current[start - 1];
    if (!anchor.trim() || !join(added)) continue;
    edits.push({
      section: label,
      from: anchor,
      to: `${anchor}\n${join(added)}`,
    });
  } else {
    const from = join(removed);
    if (!from) continue;
    edits.push({ section: label, from, to: join(added) });
  }
}
process.stdout.write(
  `${JSON.stringify({ current: currentPath, target: targetPath, edits }, null, 2)}\n`,
);
