import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://www.reddit.com/r/test/comments/18da1zl/some_test_commands/';
const GOAL = `You are already logged in via cookies. Wait 3 seconds. fill(target="join the conversation",value="Hello from weles agent"). Then js_click(text="Comment") to submit. done(value="commented"). Do NOT give_up. Do NOT navigate().`;

if (!process.env.REDDIT_EMAIL) { console.log('SKIP — set REDDIT_EMAIL'); process.exit(0); }
process.env.SVC_EMAIL = process.env.REDDIT_EMAIL;
process.env.SVC_PASSWORD = process.env.REDDIT_PASSWORD;

const s = await WSession.start({ label: 'reddit_comment', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'reddit_comment',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
