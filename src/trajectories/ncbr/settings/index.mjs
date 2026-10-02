// Which NCBR application a trajectory works on, and which browser it drives.
//
// Every NCBR script reads these here and nowhere else. None has a default:
// these scripts used to carry one applicant's project id, its section ids and
// one machine's CDP port, so a run for anyone else drove the wrong
// application in silence. A missing value is refused by name.
//
//   NCBR_CDP_ENDPOINT   the DevTools endpoint of the signed-in browser session
//   NCBR_PROJECT_ID     the LSI2 project id of the application being worked on
//   NCBR_PROJECT_URL    optional; the project's address when it is not the
//                       LSI2 project page of NCBR_PROJECT_ID
//   NCBR_SECTION_<KEY>  the projekt_step id of one section, by the key a
//                       script asks for (NCBR_SECTION_1_3 for key 1_3)
//   NCBR_PROJECT_VERSION_ID  the application's version id, for the pages
//                       addressed by version
//   NCBR_APPLICATION_TEXT_DIR  the applicant's folder holding the application
//                       text (markdown sections, contacts, audit outputs);
//                       the scripts used to name one person's home directory

const LSI2_PROJECT_BASE = 'https://lsi2.ncbr.gov.pl/projekt/';

function required(name, meaning) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set: ${meaning}; nothing is assumed`);
  return value;
}

/** The DevTools endpoint of the browser session the trajectory drives. */
export function cdpEndpoint() {
  return required('NCBR_CDP_ENDPOINT', 'name the DevTools endpoint of the signed-in NCBR browser session');
}

/** The LSI2 project id of the application being worked on. */
export function projectId() {
  return required('NCBR_PROJECT_ID', 'name the LSI2 project id of the application this run works on');
}

/** The project's page: NCBR_PROJECT_URL, or the LSI2 page of NCBR_PROJECT_ID. */
export function projectUrl() {
  const declared = process.env.NCBR_PROJECT_URL?.trim();
  return declared ? declared : `${LSI2_PROJECT_BASE}${projectId()}`;
}

/** The directory every section page of the project lives under. */
export function sectionBase() {
  return `${projectUrl()}/projekt_step/`;
}

/**
 * One section's projekt_step id, by the key the script asks for. Section ids
 * differ per application, so they are declared beside the project id rather
 * than written into a script.
 */
export function sectionId(key) {
  return required(`NCBR_SECTION_${key}`, `name the projekt_step id of section ${key.replace(/_/g, '.')}`);
}

/** One section's page, by its key. */
export function sectionUrl(key) {
  return `${sectionBase()}${sectionId(key)}`;
}

/** The project version (wersja wniosku) id the version-scoped pages use. */
export function projectVersionId() {
  return required('NCBR_PROJECT_VERSION_ID', 'name the LSI2 version id of the application this run works on');
}

/** The applicant's folder holding the application text, with a trailing slash. */
export function applicationTextDir() {
  const dir = required('NCBR_APPLICATION_TEXT_DIR', "name the applicant's folder holding the application text");
  return dir.endsWith('/') ? dir : `${dir}/`;
}

/** One file of the application text, by its name inside the folder. */
export function applicationFile(name) {
  if (!name) throw new Error('a file name inside the application text folder is required');
  return `${applicationTextDir()}${name}`;
}
