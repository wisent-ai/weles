// List all social accounts from Supabase grouped by platform
const data = JSON.parse(await (await fetch(process.argv[2], {
  headers: { apikey: process.argv[3], Authorization: 'Bearer ' + process.argv[3] }
})).text());

const platforms = {};
for (const a of data) {
  if (!platforms[a.platform]) platforms[a.platform] = [];
  platforms[a.platform].push({
    username: a.username,
    email: a.metadata?.email,
    password: a.metadata?.password,
    status: a.metadata?.status,
    cookies: a.metadata?.cookies ? 'yes' : 'no'
  });
}
for (const [p, accs] of Object.entries(platforms).sort()) {
  console.log('\n' + p.toUpperCase() + ':');
  for (const a of accs) {
    console.log(`  ${a.username} | ${a.email || ''} | ${a.password || ''} | ${a.status || ''} | cookies:${a.cookies}`);
  }
}
