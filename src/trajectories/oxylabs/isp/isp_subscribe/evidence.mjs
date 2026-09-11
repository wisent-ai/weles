// Where the ISP purchase leaves its evidence: a screenshot before every click.
import { runOutputPath } from '#run-output';
import { mkdirSync } from 'node:fs';

export const OUT_DIR = runOutputPath('keeper', 'oxylabs_isp_buy');
mkdirSync(OUT_DIR, { recursive: true });
export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

export async function shot(s, label) {
  const fp = `${OUT_DIR}/${stamp()}_${label}.png`;
  await s.page.screenshot({ path: fp, fullPage: true }).catch(() => {});
  console.log(`[shot] ${fp}`);
  return fp;
}
