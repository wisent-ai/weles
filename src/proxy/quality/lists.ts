// The organisation strings `classify.ts` matches on, read from
// `data/org-lists.json` beside this file. They are a record of what WHOIS has
// actually answered for the addresses Weles routes through, so the file says
// where each family came from and why it is matched at all.
//
// They used to be thirteen four-element arrays spread back together here,
// split that small only to stay under an inline-array-size hook. Data in a
// data file has no such problem.

import declaredOrgs from './data/org-lists.json';

export const DATACENTER_ORGS: ReadonlyArray<string> = declaredOrgs.datacenter_orgs;
export const RESIDENTIAL_ORGS: ReadonlyArray<string> = declaredOrgs.residential_orgs;
export const WHOIS_FIELDS: ReadonlyArray<string> = declaredOrgs.whois_fields;
