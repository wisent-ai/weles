import { test } from 'node:test';
import * as assert from 'node:assert';

import { classifyIp, isAcceptableForRegister } from '../../dist/proxy/quality/classify.js';
import {
  DATACENTER_ORGS,
  RESIDENTIAL_ORGS,
  WHOIS_FIELDS,
} from '../../dist/proxy/quality/lists.js';

// The shipped classifier, against real WHOIS.
//
// The organisation strings live in `src/proxy/quality/org-lists.json` — what
// registries have actually answered for the addresses Weles routes through.
// They were thirteen four-element arrays inside `lists.ts`, split that small
// only to stay under an inline-array-size hook, and nothing exercised the
// classifier at all: emptying the record, dropping a WHOIS field name or
// swapping the datacenter and residential families would all have passed.
//
// `whois` is run for real here. A registry that does not answer leaves the
// organisation empty and the verdict `unknown`, and that case is asserted
// rather than skipped — an unknown exit is usable, so an outage must not read
// as a pass for something that was never checked.

test('the record carries the families the classifier matches on', () => {
  assert.ok(DATACENTER_ORGS.includes('amazon'), 'a cloud the fleet meets is in the record');
  assert.ok(RESIDENTIAL_ORGS.includes('comcast cable'), 'a home carrier is in the record');
  assert.ok(WHOIS_FIELDS.includes('OrgName'), 'the ARIN field name');
  assert.ok(WHOIS_FIELDS.includes('descr'), 'the RIPE field name');
  assert.equal(
    new Set(DATACENTER_ORGS).size,
    DATACENTER_ORGS.length,
    'no organisation is recorded twice',
  );
});

test('an address in a cloud is classified from its registry entry', async () => {
  // 52.94.236.248 is AWS us-east-1; ARIN answers `OrgName: Amazon.com, Inc.`
  const result = await classifyIp('52.94.236.248');
  assert.equal(result.ip, '52.94.236.248');
  if (result.org === '' && result.netname === '') {
    assert.equal(result.quality, 'unknown', 'a registry that did not answer yields unknown');
    return;
  }
  assert.equal(result.quality, 'datacenter', `org=${result.org} netname=${result.netname}`);
  assert.ok(
    DATACENTER_ORGS.includes(result.matched_term ?? ''),
    `matched ${result.matched_term} which is not in the record`,
  );
  assert.equal(
    isAcceptableForRegister(result.quality),
    false,
    'a datacenter exit is not usable for register',
  );
});

test('an address nobody has recorded stays unknown and stays usable', async () => {
  // 192.0.2.1 is TEST-NET-1: reserved for documentation, no operator.
  const result = await classifyIp('192.0.2.1');
  assert.equal(result.quality, 'unknown');
  assert.equal(result.matched_term, '');
  assert.ok(isAcceptableForRegister(result.quality), 'unknown is usable');
});
