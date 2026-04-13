import { FetchAccountValue } from './dist/agent/tasks.js';

async function main() {
  const balance = await new FetchAccountValue({
    service: 'oxylabs',
    url: 'https://dashboard.oxylabs.io',
    what: 'the current account credit balance or traffic usage',
    usernameEnv: 'OXYLABS_EMAIL',
    passwordEnv: 'OXYLABS_PASSWORD',
  }).run();
  console.log('Result:', balance);
  process.exit(balance !== null ? 0 : 1);
}
main().catch(e => { console.error('Error:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT 5min'); process.exit(2); }, 300000);
