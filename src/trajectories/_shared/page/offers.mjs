// What a page offers to act on, read from its structure: the accessibility
// tree's controls (role and accessible name), form fields by their `name`
// attribute, and frames by origin. A trajectory decides its next step from
// these, never from the page's prose, so a site's wording, language or copy
// change does not change what the trajectory does. A page that cannot be
// asked (closed, navigating away) raises; absence is a plain null.

// A visible control with this role and accessible name, or null.
export async function control(page, role, name) {
  const found = page.getByRole(role, { name, exact: false }).first();
  return (await found.isVisible()) ? found : null;
}

// A visible form field with this `name` attribute, or null.
export async function field(page, name) {
  const found = page
    .locator(`input[name="${name}"], textarea[name="${name}"]`)
    .first();
  return (await found.isVisible()) ? found : null;
}

// A visible field whose `autocomplete` says what it takes (`one-time-code`,
// `new-password`, `email`, `tel`), or null.
export async function autocompleteField(page, kind) {
  const found = page.locator(`input[autocomplete="${kind}"]`).first();
  return (await found.isVisible()) ? found : null;
}

// The attached frame whose URL has this origin's host, or null.
export function frameFrom(page, host) {
  return (
    page.frames().find((frame) => {
      try {
        return new URL(frame.url()).hostname.endsWith(host);
      } catch {
        return false;
      }
    }) ?? null
  );
}

// Clicks the first of these controls that is visible and says which one, or
// null when none is.
export async function clickFirst(page, role, names) {
  for (const name of names) {
    const found = await control(page, role, name);
    if (!found) continue;
    await found.click();
    return name;
  }
  return null;
}
