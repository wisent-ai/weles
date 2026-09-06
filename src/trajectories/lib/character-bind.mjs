// Binds a freshly registered account to an unbound character stored in Skarbiec.
import {
  findAccount,
  findWelesRecordId,
  listAccounts,
  readWelesRecord,
  updateAccountMetadata,
} from '../_shared/skarbiec_accounts.mjs';

export async function autoBindCharacter(username, platform) {
  const account = findAccount(platform, username);
  if (!account) return { status: 'account_not_found' };
  const used = new Set(listAccounts(platform)
    .map((candidate) => candidate.metadata?.character?.id)
    .filter(Boolean));
  const characterId = findWelesRecordId((document, id) => {
    const context = document.context ?? {};
    const platforms = Array.isArray(context.platforms) ? context.platforms : [];
    return context.record_kind === 'character'
      && context.active !== false
      && platforms.includes(platform)
      && !used.has(id);
  });
  if (!characterId) return { status: 'no_unbound_character', platform };
  const document = readWelesRecord(characterId);
  const raw = document.fields?.character_json ?? document.fields?.value_json;
  const character = raw ? JSON.parse(String(raw)) : { id: characterId, ...document.context };
  character.id ??= characterId;
  updateAccountMetadata(account.id, { character });
  return { status: 'bound', character_id: character.id, character_name: character.name ?? null };
}
