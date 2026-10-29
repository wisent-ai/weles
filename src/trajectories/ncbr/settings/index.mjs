// Which NCBR application a trajectory works on, and which browser it drives.
//
// The NCBR actions read these here and nowhere else. None has a default: a
// project id, a section id or a browser endpoint written into a script would
// drive the wrong application in silence for anyone else. A missing value is
// refused by name.
//
//   NCBR_CDP_ENDPOINT   the DevTools endpoint of the signed-in browser session
//   NCBR_PROJECT_ID     the LSI2 project id of the application being worked on
//   NCBR_PROJECT_URL    optional; the project's address when it is not the
//                       LSI2 project page of NCBR_PROJECT_ID
//   NCBR_SECTION_<KEY>  the projekt_step id of one section, by the key an
//                       action asks for (NCBR_SECTION_1_3 for key 1_3)

// The address of NCBR's LSI2 system, the one service every NCBR trajectory
// drives. Scripts take it from here, never from a copy of their own.
const LSI2_ORIGIN = 'https://lsi2.ncbr.gov.pl';
const LSI2_PROJECT_BASE = `${LSI2_ORIGIN}/projekt/`;

/** The LSI2 origin, without a trailing slash, for login and API paths. */
export function lsi2Origin() {
  return LSI2_ORIGIN;
}

function required(name, meaning) {
  const value = process.env[name]?.trim();
  if (!value)
    throw new Error(`${name} is not set: ${meaning}; nothing is assumed`);
  return value;
}

/** The DevTools endpoint of the browser session the trajectory drives. */
export function cdpEndpoint() {
  return required(
    'NCBR_CDP_ENDPOINT',
    'name the DevTools endpoint of the signed-in NCBR browser session',
  );
}

/** The LSI2 project id of the application being worked on. */
export function projectId() {
  return required(
    'NCBR_PROJECT_ID',
    'name the LSI2 project id of the application this run works on',
  );
}

/** The project's page: NCBR_PROJECT_URL, or the LSI2 page of NCBR_PROJECT_ID. */
export function projectUrl() {
  return projectUrlFor(projectId());
}

/**
 * The page of project `id`: NCBR_PROJECT_URL when it is declared, else the
 * LSI2 project page of `id`. Every NCBR script builds a project address here,
 * whether its id comes from NCBR_PROJECT_ID or from a correction plan.
 */
export function projectUrlFor(id) {
  const declared = process.env.NCBR_PROJECT_URL?.trim();
  return declared ? declared : `${LSI2_PROJECT_BASE}${id}`;
}

/**
 * One section's projekt_step id, by the key the action asks for. Section ids
 * differ per application, so they are declared beside the project id rather
 * than written into a script.
 */
export function sectionId(key) {
  return required(
    `NCBR_SECTION_${key}`,
    `name the projekt_step id of section ${key.replace(/_/g, '.')}`,
  );
}
