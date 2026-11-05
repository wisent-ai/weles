// `weles_page_fill_secret`: fill a page field with one field of a Skarbiec
// item that Weles reads itself. A caller driving a browser through MCP signs
// in with a vault credential without the value ever passing through the
// call: `weles_page_fill` takes the value as an argument, so every agent
// that used it to type a password wrote the password into its own transcript
// and the server's request log. Here the call names the item and the field;
// the value goes from the vault into the field and nowhere else, and the
// answer says only which field of which item was filled.

import { readDocument } from '../state/skarbiec-records.js';
import { asString, getPage, textResult } from './state.js';

/** A refusal the caller can act on: what is missing, and where to put it. */
function refused(message: string): never {
  throw new Error(`weles_page_fill_secret: ${message}`);
}

/**
 * The text of `field` in the Skarbiec item `item`. An item that cannot be
 * read is refused with the vault's own reason; a field the item does not
 * hold, or holds as something other than non-empty text, is refused naming
 * the fields it does hold, never their values.
 */
function vaultField(item: string, field: string): string {
  let document: Record<string, any>;
  try {
    document = readDocument(item);
  } catch (error) {
    refused(
      `Skarbiec item ${item} could not be read: ${error instanceof Error ? error.message : String(error)}; check the id with \`skarbiec list --match ${item}\` and that this host's key opens it with \`skarbiec readers ${item}\``,
    );
  }
  const fields = document.fields;
  if (!fields || typeof fields !== 'object')
    refused(`Skarbiec item ${item} holds no fields`);
  const value = (fields as Record<string, unknown>)[field];
  if (typeof value !== 'string' || !value)
    refused(
      `Skarbiec item ${item} holds no text in field ${field}; it holds ${Object.keys(fields).join(', ') || 'no fields'}`,
    );
  return value;
}

export async function fillSecret(args: Record<string, unknown>) {
  const page = getPage(args.pageId);
  const selector = asString(args.selector, 'selector');
  const item = asString(args.item, 'item');
  const field = asString(args.field, 'field');
  const value = vaultField(item, field);
  await page.locator(selector).fill(value);
  return textResult({ filled: selector, item, field });
}
