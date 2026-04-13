import { runTask } from './dist/agent/tasks.js';
async function main() {
  console.log('Starting oxylabs_balance...');
  const result = await runTask('oxylabs_balance');
  console.log('Result:', result);
  process.exit(result ? 0 : 1);
}
main().catch(e => { console.error('Error:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT 5min'); process.exit(2); }, 300000);
