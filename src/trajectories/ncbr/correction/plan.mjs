import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const settings = await import('#ncbr-settings');
export const origin = settings.lsi2Origin();
export const normalize = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
export const sha256 = (value) =>
  createHash('sha256').update(String(value)).digest('hex');

export function loadPlan() {
  const file = process.env.NCBR_CORRECTION_PLAN_FILE;
  const raw = file
    ? readFileSync(file, 'utf8')
    : process.env.NCBR_CORRECTION_PLAN;
  if (!raw)
    throw new Error(
      'NCBR_CORRECTION_PLAN_FILE or NCBR_CORRECTION_PLAN is required',
    );
  const plan = JSON.parse(raw);
  // What each mode does, declared once: whether it writes to the application.
  // The mode is stated by the caller; none is assumed.
  const behaviours = {
    apply: { writes: true },
    verify: { writes: false },
    inspect: { writes: false },
  };
  const mode = process.env.NCBR_CORRECTION_MODE;
  if (!mode || !Object.hasOwn(behaviours, mode))
    throw new Error(
      `NCBR_CORRECTION_MODE must be one of ${Object.keys(behaviours).join(', ')}; got ${mode ? JSON.stringify(mode) : 'nothing'}`,
    );
  if (plan.schema !== 'weles.ncbr.correction-plan.v1')
    throw new Error('unsupported correction schema');
  const project = plan.project;
  if (
    !project ||
    !/^[0-9a-f-]{36}$/.test(project.id) ||
    project.neverSubmit !== true
  ) {
    throw new Error('A project UUID and neverSubmit=true are required');
  }
  if (
    !project.titleNeedle ||
    !project.applicationNumber ||
    !project.allowedStatusNeedles?.length
  ) {
    throw new Error(
      'The application number, title and allowed statuses are required',
    );
  }
  const deadline = Date.parse(project.deadline);
  if (!Number.isFinite(deadline))
    throw new Error('invalid correction deadline');
  if (behaviours[mode].writes && Date.now() > deadline)
    throw new Error('correction deadline has passed');
  if ('correctionCard' in plan)
    throw new Error(
      'KPW recommendation text belongs to the reviewer; remove correctionCard',
    );
  if (!Array.isArray(plan.sections) || !Array.isArray(plan.collections))
    throw new Error('sections and collections must be arrays');
  const projectUrl = settings.projectUrlFor(project.id);
  for (const scope of [...plan.sections, ...plan.collections]) {
    const recommendations = scope.url === `${projectUrl}/recomendations`;
    if (
      !recommendations &&
      !scope.url?.startsWith(`${projectUrl}/projekt_step/`)
    )
      throw new Error(`unsafe section URL: ${scope.url}`);
    // On the KPW page only the applicant's "Wyjaśnienia dot. braku poprawy" fields are writable; the reviewer's text never is.
    if (
      recommendations &&
      (scope.fields || []).some(
        (field) =>
          !String(field.name || '').endsWith('.beneficiaryExplanation'),
      )
    ) {
      throw new Error(
        `${scope.label}: only beneficiaryExplanation fields may be written on the recommendations page`,
      );
    }
    for (const row of scope.rows || []) {
      // A row is found by what it is about, judged by the model over every
      // row's text; a spelling to search for misses the next way it is typed.
      if ('rowNeedle' in row)
        throw new Error(
          `${scope.label}: rowNeedle is no longer read; state what the row is about as rowSubject`,
        );
      if (!row.rowSubject || !row.matchField || !row.matchNeedle)
        throw new Error(
          `incomplete row identity in ${scope.label}: each row needs rowSubject (a sentence naming what the row is about), matchField and matchNeedle`,
        );
    }
  }
  return { plan, mode, projectUrl, planSha256: sha256(raw) };
}

export function editedValue(before, field, plan) {
  if (typeof field.value === 'string') return field.value;
  const edits = field.editSet ? plan.editSets?.[field.editSet] : field.edits;
  if (!Array.isArray(edits))
    throw new Error(
      `${field.name || field.nameSuffix} requires value or edits`,
    );
  let value = before;
  for (const edit of edits) {
    if (
      typeof edit.from !== 'string' ||
      !edit.from ||
      typeof edit.to !== 'string'
    )
      throw new Error('invalid literal edit');
    if (value.includes(edit.from)) value = value.replaceAll(edit.from, edit.to);
    else if (edit.to && !value.includes(edit.to) && !edit.optional)
      throw new Error(`Expected text not found: ${edit.from}`);
  }
  if (value === before) return before;
  return field.editSet
    ? value
        .replace(/ {2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : value;
}
