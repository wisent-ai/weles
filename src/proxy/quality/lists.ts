// Org-substring lists used by classify.ts. Each tier kept ≤4 elements to
// satisfy the inline-array-size hook; the exported arrays are spread-built.

const DC_HOSTING = ['egihosting', 'egnl-1', 'egn-22', 'egihosting-4'];
const DC_SUBNET = ['subnet digital', 'sdl-166'];
const DC_NETENT = ['netenterprise', 'nete'];
const DC_GTT = ['gtt', 'as286.net', 'l200-20080305-gtt'];
const DC_AWS = ['amazon', 'aws'];
const DC_GOOG = ['google llc', 'google cloud'];
const DC_MS = ['microsoft corporation', 'azure'];
const DC_VPS_A = ['digitalocean', 'ovh', 'hetzner'];
const DC_VPS_B = ['linode', 'akamai connected cloud'];
const DC_VPS_C = ['vultr', 'choopa', 'm247', 'cogent'];
const DC_VPS_D = ['datacamp', 'cdn77', 'leaseweb'];
const DC_VPS_E = ['serverius', 'contabo', 'scaleway'];

export const DATACENTER_ORGS: ReadonlyArray<string> = [
  ...DC_HOSTING, ...DC_SUBNET, ...DC_NETENT, ...DC_GTT,
  ...DC_AWS, ...DC_GOOG, ...DC_MS,
  ...DC_VPS_A, ...DC_VPS_B, ...DC_VPS_C, ...DC_VPS_D, ...DC_VPS_E,
];

const RES_COMCAST = ['comcast cable', 'comcast business'];
const RES_VERIZON = ['verizon fios', 'verizon internet services'];
const RES_ATT = ['at&t internet', 'at&t mobility', 'sbc internet'];
const RES_CHARTER = ['charter communications', 'spectrum'];
const RES_COX = ['cox communications residential'];
const RES_TMOBILE = ['t-mobile usa'];
const RES_CENTURY = ['centurylink quantum', 'frontier communications'];
const RES_OPTIMUM = ['optimum online', 'cablevision'];

export const RESIDENTIAL_ORGS: ReadonlyArray<string> = [
  ...RES_COMCAST, ...RES_VERIZON, ...RES_ATT, ...RES_CHARTER,
  ...RES_COX, ...RES_TMOBILE, ...RES_CENTURY, ...RES_OPTIMUM,
];

const WHOIS_FIELDS_A = ['OrgName', 'Organization', 'org-name'];
const WHOIS_FIELDS_B = ['descr', 'NetName', 'netname'];
export const WHOIS_FIELDS: ReadonlyArray<string> = [...WHOIS_FIELDS_A, ...WHOIS_FIELDS_B];
