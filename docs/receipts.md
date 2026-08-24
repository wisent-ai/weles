# Receipts

How does a caller prove what Weles did without trusting Weles' word for it?
With a signed receipt: a deployment configured for receipt issuance closes a
task's terminal response with a document whose claims are bound by a signature
the caller verifies offline, against keys the caller owns. The verifier is the
public [`@wisent-ai/weles-client`](https://github.com/wisent-ai/weles-client),
and it fails closed.

## What is signed

The receipt document (`schema: weles.receipt.current`) carries three
verification fields and the displayed claims beside them:

| Field | Meaning |
|---|---|
| `keyId` | Names the trusted public key in the caller's key map |
| `signature` | Base64 signature over `signedPayload` |
| `signedPayload` | The exact JSON text of the claims that were signed |
| `taskId`, `organizationId`, `origin`, `action`, `outcome`, `evidenceDigest` | Displayed copies of the signed claims |

The signed payload binds the six claims together: which task, for which
organization, against which origin, doing which action, with which outcome,
over which evidence. `evidenceDigest` is a digest of the run's retained
evidence, so the receipt commits to the evidence without containing it; the
worker uploads the complete run tree to private storage before any result is
published ([workflows](workflows.md)). First-use receipts additionally carry
signed `subject`, `audience`, and `product` claims.

## What a verifier checks

`verifyReceipt(receipt, keys)` in `weles-client` performs, in order:

1. the receipt is an object and `schema` is exactly `weles.receipt.current` —
   anything else is `unsupported-receipt`;
2. `keyId`, `signature`, and `signedPayload` are non-empty strings;
3. `keyId` resolves in the caller-supplied key map (key ID → PEM public key);
   an unknown key is `unknown-receipt-key` — the receipt never supplies its
   own verification key;
4. the signature verifies over the exact `signedPayload` bytes with Node's
   `crypto.verify`; failure is `invalid-receipt-signature`;
5. `signedPayload` parses as a JSON object; failure is
   `invalid-receipt-payload`;
6. every displayed field — `taskId`, `organizationId`, `origin`, `action`,
   `outcome`, `evidenceDigest` — must equal its signed claim; any difference
   is `receipt-claim-mismatch`.

Only then are the frozen claims returned. Verification proves that one
trusted key signed exactly this payload and that the displayed fields match
it; it deliberately does not check key revocation, certificate chains,
freshness, evidence availability, or target-side truth — those stay with the
caller (`weles-client` README).

The client verifies automatically: `submit`, `get`, and `cancel` each run
`verifyReceipt` on any `receipt` present in the response before returning it.

## Verifying locally

`weles onboarding verify` is the executor-side wrapper around the same
verifier:

```bash
weles onboarding verify --receipt <receipt.json> --keys <receipt-keys.json>
```

`--keys` is a non-empty JSON map of key IDs to PEM public keys; `--receipt`
accepts the receipt document or an envelope with a `receipt` field. The CLI
requires every verified claim (`taskId`, `organizationId`, `origin`,
`action`, `outcome`, `evidenceDigest`, `keyId`) to be a non-empty string and
completes first use only when the signed `outcome` is `completed`
(`src/onboarding.ts`). Trusted keys must arrive through a separately
authenticated channel.

## Other receipts named "receipt"

Two adjacent mechanisms share the word but not the schema. Browser installs
write a `.weles-release` receipt recording the exact release URI, archive
SHA-256, and platform; the browser launches only when that file matches the
configured coordinate byte for byte (`src/session/find_browser.ts`). And
release promotion requires a signed Probierz evidence receipt covering the
candidate's contract runs before any ring activation
([worker lifecycle](worker-lifecycle.md)). Neither is a workflow receipt;
only `weles.receipt.current` binds a task outcome.
