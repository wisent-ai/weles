// `weles open <url>`: one page opened in a browser launched from the command
// line's options, answered with its address, title, HTTP status and, when
// asked, a screenshot and the page's text.
import type { AsyncNewBrowserOptions } from '../../async_api.js';
import type { ParsedCli } from '../../cli.js';
import { UsageError, printAnswer } from '../usage.js';

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cliOptionsToBrowserOptions(
  options: Record<string, string | boolean>,
): AsyncNewBrowserOptions {
  const browserOptions: AsyncNewBrowserOptions = {
    headless: options.headless === true,
  };
  if (typeof options.browser === 'string')
    browserOptions.browser = options.browser;
  if (typeof options.os === 'string') browserOptions.os = options.os;
  if (typeof options.locale === 'string') {
    // The page's language: Chromium's --lang, Firefox's
    // intl.accept_languages and the Accept-Language header all take it.
    let canonical: string;
    try {
      [canonical] = Intl.getCanonicalLocales(options.locale);
    } catch {
      throw new UsageError(
        `--locale ${JSON.stringify(options.locale)} is not a BCP 47 language tag; give one such as pl-PL or de`,
      );
    }
    browserOptions.locale = canonical;
  }
  if (typeof options['user-data-dir'] === 'string')
    browserOptions.userDataDir = options['user-data-dir'];
  if (typeof options.proxy === 'string')
    browserOptions.proxy = { server: options.proxy };
  return browserOptions;
}

/** Console output goes to standard error, so standard output carries only the answer. */
function routeConsoleToStderr(): void {
  console.log = (...args: unknown[]) => console.error(...args);
}

export async function runOpen(parsed: ParsedCli): Promise<void> {
  const [url] = parsed.positional;
  if (!url) throw new UsageError('open requires <url>');
  routeConsoleToStderr();
  const { AsyncNewBrowser } = await import('../../async_api.js');
  const context = await AsyncNewBrowser(
    cliOptionsToBrowserOptions(parsed.options),
  );
  let out: Record<string, unknown> | undefined;
  let operationError: unknown;
  let operationFailed = false;
  try {
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (typeof parsed.options['wait-for-text'] === 'string') {
      await page
        .getByText(parsed.options['wait-for-text'], { exact: false })
        .first()
        .waitFor({ state: 'visible' });
    }
    out = {
      ok: true,
      url: page.url(),
      title: await page.title(),
      // A navigation within the document answers no HTTP response.
      status: response ? response.status() : null,
    };
    if (typeof parsed.options.screenshot === 'string') {
      await page.screenshot({
        path: parsed.options.screenshot,
        fullPage: true,
      });
      out.screenshot = parsed.options.screenshot;
    }
    if (parsed.options.text === true)
      out.text = await page.locator('body').innerText();
  } catch (error) {
    operationError = error;
    operationFailed = true;
    throw error;
  } finally {
    try {
      await context.close();
    } catch (closeError) {
      if (operationFailed)
        throw new AggregateError(
          [operationError, closeError],
          `${parsed.command} failed: ${failure(operationError)}; browser close failed: ${failure(closeError)}`,
        );
      throw new Error(
        `closing browser after ${parsed.command} failed: ${failure(closeError)}`,
        { cause: closeError },
      );
    }
  }
  if (!out)
    throw new Error(`${parsed.command} completed without a navigation result`);
  printAnswer(out, parsed.options.json === true);
}
