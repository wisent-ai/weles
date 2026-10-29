// The credential shapes Weles never lets leave a process or stay on disk, the
// one list every redactor reads: the worker's HTTP answers
// (worker/weles-api-server/http-exchange.mjs), the DOM a run keeps of its
// pages (session capture checkpoints) and `weles recordings scrub`, which
// rewrites runs recorded before the capture redacted them. CommonJS, so the
// ECMAScript modules of the worker and the TypeScript compiled to CommonJS
// import it alike.
'use strict';

// The middle word of a <service>_<kind>_<value> token.
const SECRET_KINDS = {
  secret: true,
  key: true,
  token: true,
  pat: true,
  api: true,
  db: true,
};

// Each shape with what replaces it. A replacement holds no quote, backslash or
// control character, so a shape replaced inside JSON text leaves it JSON.
const SECRET_SHAPES = [
  // A JSON Web Token: three base64url segments, the first two JSON objects.
  [/eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+/g, '[redacted-jwt]'],
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '[redacted-pem]',
  ],
  // Slack tokens (https://api.slack.com/concepts/token-types).
  [/xox[baprs]-[A-Za-z\d-]+/g, '[redacted-slack]'],
  // An AWS access key id, AKIA or ASIA
  // (https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_identifiers.html#identifiers-unique-ids).
  [/\bA[KS]IA(?=[A-Z\d]*\d)[A-Z\d]+\b/g, '[redacted-aws]'],
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ and fine-grained github_pat_
  // (https://github.blog/engineering/platform-security/behind-githubs-new-authentication-token-formats/).
  [/\b(?:gh[pousr]_[A-Za-z\d]+|github_pat_\w+)/g, '[redacted-github]'],
  // Stripe secret and restricted keys, live and test (https://docs.stripe.com/keys).
  [/\b[sr]k_(?:live|test)_[A-Za-z\d]+/g, '[redacted-stripe]'],
  // A <service>_<kind>_<value> token whose value mixes letters and digits (an
  // identifier such as account_key_id is not one).
  [
    new RegExp(
      `\\b[a-z]+_(?:${Object.keys(SECRET_KINDS).join('|')})_(?=[A-Za-z\\d]*\\d)(?=[A-Za-z\\d]*[A-Za-z])[A-Za-z\\d]+`,
      'gi',
    ),
    '[redacted-secret]',
  ],
];

/** `text` with every credential shape replaced by a marker naming its kind. */
function withoutSecretShapes(text) {
  return SECRET_SHAPES.reduce(
    (kept, [shape, replacement]) => kept.replace(shape, replacement),
    text,
  );
}

exports.withoutSecretShapes = withoutSecretShapes;
