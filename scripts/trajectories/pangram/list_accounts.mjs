// Read-only Pangram account pool diagnostic. Prints non-secret account metadata only.
import { listAccounts } from '../_shared/skarbiec_accounts.mjs';

const rows = listAccounts('pangram');
console.log(JSON.stringify(rows.map((account, i) => ({
  i,
  id: account.id,
  username: account.username,
  created_at: account.document.context?.created_at ?? null,
})), null, 2));
