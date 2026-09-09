/**
 * Does the wire look like the browser the page claims to be?
 *
 * JA4, peetprint, the Akamai HTTP/2 signature and the request header order
 * are all produced below JavaScript, by the TLS library and the HTTP stack.
 * No amount of page-level patching moves them, and no page-level rule can
 * explain them: an operator who sees a JA4 diff has to change the transport,
 * not the fingerprint script.
 *
 * That is the whole reason this family is separate. It is measured by the
 * network probe rather than the in-page probe, it is fixed in a different
 * layer of the product, and it changes when Chromium's cipher list, SETTINGS
 * frame or HPACK behaviour changes — never when a DOM API does.
 */

import type { DetectionRule } from '../finding.js';

export const transportFingerprintRules: DetectionRule[] = [
  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------
  {
    id: 'tls_ja4_mismatch',
    name: 'TLS JA4 fingerprint mismatch',
    category: 'network',
    severity: 'critical',
    test(s, b) {
      const sj = s?.network?.ja4;
      const bj = b?.network?.ja4;
      if (sj && bj && sj !== bj) {
        return {
          id: 'tls_ja4_mismatch',
          category: 'network',
          severity: 'critical',
          message: `TLS JA4 fingerprint differs (${sj} vs ${bj}). LinkedIn can TLS-fingerprint clients.`,
          evidence: { subjectJa4: sj, baselineJa4: bj },
        };
      }
      return null;
    },
  },
  {
    id: 'tls_peetprint_mismatch',
    name: 'TLS peetprint mismatch',
    category: 'network',
    severity: 'critical',
    test(s, b) {
      const sp = s?.network?.peetprint_hash;
      const bp = b?.network?.peetprint_hash;
      if (sp && bp && sp !== bp) {
        return {
          id: 'tls_peetprint_mismatch',
          category: 'network',
          severity: 'critical',
          message: `TLS peetprint hash differs (${sp} vs ${bp}). Independent TLS signature from JA4.`,
          evidence: { subjectPeetprint: sp, baselinePeetprint: bp },
        };
      }
      return null;
    },
  },
  {
    id: 'h2_akamai_fingerprint_mismatch',
    name: 'HTTP/2 Akamai fingerprint mismatch',
    category: 'network',
    severity: 'critical',
    test(s, b) {
      const sh = s?.network?.akamaiH2;
      const bh = b?.network?.akamaiH2;
      if (sh && bh && sh !== bh) {
        return {
          id: 'h2_akamai_fingerprint_mismatch',
          category: 'network',
          severity: 'critical',
          message: `HTTP/2 Akamai fingerprint differs. Akamai Bot Manager uses SETTINGS + HPACK + pseudo-header order to score clients.`,
          evidence: { subjectAkamaiH2: sh, baselineAkamaiH2: bh },
        };
      }
      return null;
    },
  },
  {
    id: 'http_header_order_mismatch',
    name: 'HTTP request header order mismatch',
    category: 'network',
    severity: 'warning',
    test(s, b) {
      const sh = s?.network?.headers;
      const bh = b?.network?.headers;
      if (!sh || !bh) return null;
      const sKeys = Object.keys(sh).join('|');
      const bKeys = Object.keys(bh).join('|');
      if (sKeys !== bKeys) {
        return {
          id: 'http_header_order_mismatch',
          category: 'network',
          severity: 'warning',
          message: `Browser-sent header order differs from baseline. PerimeterX/DataDome/Akamai compare header order.`,
          evidence: { subjectHeaderKeys: Object.keys(sh), baselineHeaderKeys: Object.keys(bh) },
        };
      }
      return null;
    },
  },
];
