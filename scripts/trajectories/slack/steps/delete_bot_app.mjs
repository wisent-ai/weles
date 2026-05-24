// Delete a Slack app via api.slack.com.
//
// Caller must already be authenticated to api.slack.com — i.e. have done
// the Google SSO into wisent-workspace.slack.com and visited
// /apps/manage to seat the workspace handoff cookie.
//
// We POST the hidden delete-form directly instead of clicking
// #delete_app_button. The button's onclick uses window.confirm(), which
// Playwright auto-dismisses unless a page.on('dialog') handler is
// attached — so a humanized click visibly fires but the JS handler bails
// inside the confirm. Reading the form's CSRF crumb and POSTing via
// page.context().request reuses the page's cookies and skips the dialog
// entirely.

export async function deleteBotApp({ page, appId }) {
  if (!appId || !/^A[A-Z0-9]+$/.test(appId)) {
    throw new Error(`deleteBotApp: invalid appId "${appId}"`);
  }

  await page.goto(`https://api.slack.com/apps/${appId}/general`, { waitUntil: 'domcontentloaded' });
  const crumb = await page.evaluate(() => {
    const i = document.querySelector('#delete_application_form input[name=crumb]');
    return i ? i.value : '';
  });
  if (!crumb) throw new Error(`deleteBotApp: no CSRF crumb on /apps/${appId}/general (not signed in?)`);

  const r = await page.context().request.post(`https://api.slack.com/apps/${appId}/general`, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    data: `delete=1&crumb=${encodeURIComponent(crumb)}`,
    maxRedirects: 5,
  });
  const finalUrl = r.url();
  if (r.status() !== 200 || !finalUrl.includes('deleted=1')) {
    throw new Error(`deleteBotApp: unexpected response ${r.status()} ${finalUrl}`);
  }

  // Confirm by re-navigating: the app's general page should no longer render
  // the delete button (Slack returns the "Oh no!" 404 once the app is gone).
  await page.goto(`https://api.slack.com/apps/${appId}/general`, { waitUntil: 'domcontentloaded' });
  const stillHasButton = await page.evaluate(() => !!document.querySelector('#delete_app_button'));
  if (stillHasButton) {
    throw new Error(`deleteBotApp: ${appId} still has #delete_app_button after POST — not deleted`);
  }
}
