// What an NCBR (LSI2) trajectory run is about, read once from the
// environment and refused by name when absent. No browser endpoint, project
// or section is assumed: these scripts used to carry one applicant's project
// id and one machine's CDP port, so a run for anyone else drove the wrong
// application in silence.
//
//   NCBR_CDP_ENDPOINT   the CDP address of the browser that holds the LSI2 session
//   NCBR_PROJECT_ID     the LSI2 project (wniosek) the run works on
//   NCBR_SECTION_<KEY>  the projekt_step id of one section, by the key a script asks for

const LSI_ORIGIN = 'https://lsi2.ncbr.gov.pl';

function required(name, meaning) {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(`${name} is required: ${meaning}; nothing is assumed`);
  }
  return value.trim();
}

/** The CDP endpoint of the browser the run attaches to. */
export function cdpEndpoint() {
  return required('NCBR_CDP_ENDPOINT', 'the CDP address of the browser holding the LSI2 session');
}

/** The LSI2 project id this run works on. */
export function projectId() {
  return required('NCBR_PROJECT_ID', 'the LSI2 project the run works on');
}

/** The project's page. */
export function projectUrl() {
  return `${LSI_ORIGIN}/projekt/${projectId()}`;
}

/** The directory every section page of the project lives under. */
export function sectionBase() {
  return `${projectUrl()}/projekt_step/`;
}

/**
 * One section's page, by the key the script asks for: `NCBR_SECTION_1_3`
 * for key `1_3`. Section ids differ per application, so they are declared
 * beside the project id rather than written into a script.
 */
export function sectionUrl(key) {
  const id = required(`NCBR_SECTION_${key}`, `the projekt_step id of section ${key.replace('_', '.')}`);
  return `${sectionBase()}${id}`;
}
