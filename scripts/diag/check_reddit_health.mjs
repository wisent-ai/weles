import { WSession } from '../../dist/session/wsession.js';
const accts = ['loganvega6041','katiepratt9147','mayapratt1005','sagestone6654','sagequinn1066'];
const s = await WSession.start({label:'health_check', proxy:'residential'});
try {
  for (const u of accts) {
    await s.page.goto('https://www.reddit.com/user/' + u + '/about.json', {waitUntil:'domcontentloaded'});
    await s.page.waitForTimeout(2000);
    const t = await s.page.evaluate(() => document.body.innerText).catch(() => '');
    const healthy = t.includes('comment_karma');
    console.log(u + ': ' + (healthy ? 'HEALTHY' : 'SHADOWBANNED'));
  }
} finally { await s.close(); }
