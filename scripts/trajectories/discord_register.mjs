import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://discord.com/register';
const GOAL = `generate_identity(platform="discord"). Fill Email with $DISCORD_NEW_EMAIL. Fill "Display Name" with $DISCORD_NEW_USERNAME. Fill Username with $DISCORD_NEW_USERNAME. Fill Password with $DISCORD_NEW_PASSWORD. For Date of Birth use select_option(target="month",value=$DISCORD_NEW_BIRTHMONTH), select_option(target="day",value=$DISCORD_NEW_BIRTHDAY), select_option(target="year",value=$DISCORD_NEW_BIRTHYEAR). Click "Create Account". If captcha, solve_captcha(sitekey="auto"). If email verification, check_email(email=$DISCORD_NEW_EMAIL,sender="discord"). done(value=$DISCORD_NEW_USERNAME).`;

const s = await WSession.start({ label: 'discord_register', proxy: process.env.PROXY_URL || 'residential' });
try {
  await s.goto(URL);
  await s.wait(3);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, { flowName: 'discord_register' });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
