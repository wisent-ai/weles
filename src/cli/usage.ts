// The invocation itself is wrong: a missing argument or flag, an unknown
// command or action, flags that contradict each other. A class rather than a
// phrase, so the entry point tells it from a failure of a well-formed command
// without reading the message: a usage error exits 2, every other failure 1.
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** The exit status for a failure the CLI caught. */
export function exitStatusFor(error: unknown): number {
  return error instanceof UsageError ? 2 : 1;
}

/**
 * One answer as `--json` prints it, or as lines a person reads: an object
 * prints `key: value` per field (a string as itself, null as `-`, anything
 * nested as compact JSON), a list prints one compact item per line.
 */
export function printAnswer(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const line = (item: unknown): string => {
    if (item === null || item === undefined) return '-';
    return typeof item === 'string' ? item : JSON.stringify(item);
  };
  if (Array.isArray(value)) {
    process.stdout.write(value.map((item) => `${line(item)}\n`).join(''));
    return;
  }
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>);
    process.stdout.write(fields.map(([key, field]) => `${key}: ${line(field)}\n`).join(''));
    return;
  }
  process.stdout.write(`${line(value)}\n`);
}

export const HELP = `Weles CLI

Usage:
  weles onboarding [status|next|import|verify|reset] [--subject <stable-id>] [--json]
  weles onboarding import <trajectory-export.json> --host <managed-worker-hostname> [--subject <stable-id>] [--json]
  weles onboarding verify --receipt <receipt.json> --keys <receipt-keys.json> [--subject <stable-id>] [--json]
  weles import <trajectory-export.json> --host <managed-worker-hostname> [--json]
  weles open <url> [--headless] [--browser chromium|firefox] [--wait-for-text <text>] [--text] [--screenshot <file>] [--json]
  weles screenshot <url> <file> [--headless] [--browser chromium|firefox] [--wait-for-text <text>] [--json]
  weles mcp
  weles release surface [--root <directory>]
  weles release enforce-version --decision <file> --baseline <file> --declaration <file> --manifest <file> [--json]
  weles release validate-manifest --manifest <file> --source-revision <sha> --candidate-tag <tag> [--json]
  weles release adopt-baseline --released <version> --published-surface <file> --reason <text> [--correcting <version>] [--json]
  weles figma export-design-assets
  weles figma parse-document <document.json[.gz]> <summary.json> <nodes.json> [<vocabulary.json>]
  weles operator-requests list [--open] [--limit <n>] [--json]
  weles operator-requests show <id> [--json]
  weles operator-requests open --kind <kind> --account <account> --run <run> --instruction <text> [--pid <waiting-process>]
  weles operator-requests close <id> --approved|--unapproved --detail <text>
  weles account-security --login-role <skarbiec-role> [--json]
  weles account-security --run <run-id> [--json]
  weles app-password --login-role <skarbiec-role> [--json]
  weles app-password --login-item <skarbiec-item> [--json]
  weles app-password --run <run-id> [--json]
  weles developer-certificate --provider apple --subject <dn> [--account-role <role>] --confirm "AUTHORIZE ONE APPLE DEVELOPER ID" --execution-host <host> --private-key-out <abs> [--execution-agent <agent>] [--expires-in-minutes <n>] [--json]
  weles developer-certificate --run <run-id> --certificate-out <abs> [--private-key <abs> --store-host <host>] [--json]
  weles login --provider apple [--account-role <role>] --confirm "AUTHORIZE ONE APPLE LOGIN" --execution-host <host> [--execution-agent <agent>] [--expires-in-minutes <n>] [--json]
  weles login --run <run-id> [--json]
  weles worker <status|start|stop|restart> [--json]
  weles keeper start --session <id> [--url <url>] [--headless]
                          Hold one browser session that answers JSON commands on
                          ~/.weles/keeper/<id>/socket until its page closes
  weles records adopt [--json]  Tag every Weles record in this vault with weles:record:<kind> from its own context
  weles doctor [--json]
  weles version

Options:
  --subject <stable-id>   Stable operator/device scope for durable onboarding progress.
  --receipt <file>        Real terminal Weles service receipt JSON to verify.
  --keys <file>           JSON map of trusted receipt key IDs to PEM public keys.
  --state-dir <dir>       Override the durable onboarding state directory.
  --host <hostname>       Exact managed Weles worker hostname for imported definitions.
  --provider <name>       The provider a login or developer certificate goes through; apple is the
                          one Weles implements, and none is assumed.
  --login-role <role>     The Skarbiec role the Google login plays (the item tagged stado:role:<role>).
                          account-security reads 2FA without signing in; app-password signs in,
                          creates a Google app password and hands it to Skrzynka.
  --login-item <item>     Exact Skarbiec Google login for app-password when no role is assigned.
  Worker controls reach the executor at the route 'stado service directory connect weles-admission'
  gives and with the Skarbiec token at the <item>#<field> WELES_WORKER_TOKEN_ITEM names;
  WELES_WORKER_API_BASE and WELES_WORKER_TOKEN override both.
  --headless              Launch without a visible browser window.
  --browser <name>        Browser engine passed to AsyncNewBrowser (default: chromium).
  --os <name>             Persona OS passed to AsyncNewBrowser (default: macos).
  --locale <locale>       Locale passed to AsyncNewBrowser.
  --chromium-path <path>  Custom Chromium binary path.
  --user-data-dir <dir>   Browser profile directory.
  --proxy <url>           Proxy server URL.
  --text                  Print document body text after navigation.
  --screenshot <file>     Save a screenshot after navigation.
  --wait-for-text <text>  Wait for matching visible text before reading or capturing.
  --open                  List only requests still waiting for the operator.
  --limit <n>             How many operator requests to list (default 20).
  --json                  Print the answer as one JSON document instead of key: value lines.
                          release surface always prints its JSON document: it is the file a release carries.
  --kind <kind>           What kind of action the run needs from the operator.
  --account <account>     The account the operator action belongs to.
  --run <run>             The run that is waiting.
  --instruction <text>    What the operator has to do, in his own terms.
  --pid <process>         The process that waits on the request (default: the caller's parent);
                          a request whose process ended is reported abandoned, never timed out.
  --approved              The operator did the thing this request asked for.
  --unapproved            The wait ended without the operator doing it.
  --detail <text>         One sentence saying how the wait ended.

Onboarding explains the authorization boundary, optionally imports existing Weles
trajectory API exports, and explains approved host execution. Importing writes
host-bound drafts but does not launch browser automation or grant a new action.
Completion still requires cryptographic verification of a real workflow receipt
and its bound evidence digest.
`;
