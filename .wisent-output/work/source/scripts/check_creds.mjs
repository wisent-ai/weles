const url = process.env.WELES_DATABASE_URL;
const key = process.env.WELES_DATABASE_TOKEN;
const h = { apikey: key, Authorization: 'Bearer ' + key };

const r1 = await fetch(url + '/rest/v1/service_credentials?select=id,login_email', { headers: h });
const services = await r1.json();
console.log('Service credentials:');
for (const s of services) console.log('  ' + s.id + ': ' + s.login_email);

const r2 = await fetch(url + '/rest/v1/social_accounts?status=eq.active&select=platform,username&limit=20', { headers: h });
const accounts = await r2.json();
console.log('Social accounts:');
for (const a of accounts) console.log('  ' + a.platform + '/' + a.username);
