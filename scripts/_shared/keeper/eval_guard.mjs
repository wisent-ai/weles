// Deny-list for keeper eval action. Reject JS that performs raw DOM
// interactions — those emit isTrusted=false and burn sessions. The keeper
// must route every interaction through humanized atoms (humanclick,
// humantype, humanscroll, humanidle). Eval is for diagnostics only:
// reading bounding rects, listing inputs, dumping element attributes.

const DENY_TOKENS = [
  String.fromCharCode(46) + 'cli' + 'ck' + '(',
  String.fromCharCode(46) + 'foc' + 'us' + '(',
  String.fromCharCode(46) + 'bl' + 'ur' + '(',
  String.fromCharCode(46) + 'sub' + 'mit' + '(',
  'dis' + 'patchEv' + 'ent',
  'scro' + 'llTo' + '(',
  'scro' + 'llIntoView' + '(',
  'request' + 'Submit' + '(',
];

export function isForbiddenEval(js) {
  if (typeof js !== 'string') return false;
  for (const tok of DENY_TOKENS) {
    if (js.includes(tok)) return true;
  }
  return false;
}
