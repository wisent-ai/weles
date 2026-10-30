// The weles command line's grammar: which word names which command, and which
// options take a value. An unknown command is refused by name.
import type { CliCommand, ParsedCli } from '../../cli.js';
import { UsageError } from '../usage.js';

/** Each word a caller may type and the command it names. */
const COMMANDS: Readonly<Record<string, CliCommand>> = Object.freeze({
  help: 'help',
  '--help': 'help',
  '-h': 'help',
  version: 'version',
  '--version': 'version',
  '-v': 'version',
  doctor: 'doctor',
  open: 'open',
  mcp: 'mcp',
  onboarding: 'onboarding',
  import: 'import',
  release: 'release',
  design: 'design',
  runs: 'runs',
  security: 'security',
  password: 'password',
  certificate: 'certificate',
  login: 'login',
  worker: 'worker',
  records: 'records',
  recordings: 'recordings',
  keeper: 'keeper',
  pointer: 'pointer',
  errors: 'errors',
});

/** The options that take the argument after them as their value. */
const VALUE_OPTIONS: Readonly<Record<string, true>> = Object.freeze({
  'login-item': true,
  'login-role': true,
  browser: true,
  os: true,
  locale: true,
  'user-data-dir': true,
  proxy: true,
  screenshot: true,
  'wait-for-text': true,
  subject: true,
  receipt: true,
  keys: true,
  'state-dir': true,
  host: true,
  decision: true,
  baseline: true,
  declaration: true,
  manifest: true,
  'source-revision': true,
  'candidate-tag': true,
  released: true,
  'published-surface': true,
  reason: true,
  source: true,
  correcting: true,
  root: true,
  run: true,
  detail: true,
  'account-role': true,
  confirm: true,
  'execution-host': true,
  'execution-agent': true,
  'private-key-out': true,
  'certificate-out': true,
  'expires-in-minutes': true,
  'private-key': true,
  'store-host': true,
  session: true,
  url: true,
  provider: true,
  organization: true,
  request: true,
});

const OPTION_PREFIX = '--';

/** The command `word` names; no word, or an empty one, asks for help. */
function commandNamed(word: string | undefined): CliCommand {
  if (!word) return 'help';
  if (!Object.hasOwn(COMMANDS, word))
    throw new UsageError(`unknown command: ${word}`);
  return COMMANDS[word];
}

export function parseCliArgs(argv: string[]): ParsedCli {
  const [word, ...rest] = argv;
  const command = commandNamed(word);
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  const queue = [...rest];
  while (queue.length) {
    const arg = queue.shift() as string;
    if (!arg.startsWith(OPTION_PREFIX)) {
      positional.push(arg);
      continue;
    }
    const [key, ...valueParts] = arg.slice(OPTION_PREFIX.length).split('=');
    if (valueParts.length) {
      options[key] = valueParts.join('=');
      continue;
    }
    const [next] = queue;
    if (
      next &&
      !next.startsWith(OPTION_PREFIX) &&
      Object.hasOwn(VALUE_OPTIONS, key)
    ) {
      options[key] = next;
      queue.shift();
    } else {
      options[key] = true;
    }
  }
  return { command, positional, options };
}
