/**
 * A screenshot is evidence of a step, never the step itself. A page that is
 * mid-navigation or already closed refuses the capture, and that refusal is
 * worth a log line, not the end of the run. Returns the written path, or false
 * when nothing was captured.
 */
export async function screenshotIfPossible(s, label) {
  try {
    return await s.screenshot(label);
  } catch (error) {
    console.log(`[screenshot] ${label} not captured: ${String(error?.message ?? error).slice(0, 120)}`);
    return false;
  }
}
