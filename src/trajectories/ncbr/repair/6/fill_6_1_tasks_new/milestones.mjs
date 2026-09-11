// The milestone sub-rows of a task, bound to the page and the task form.
import { humanClickLocator, humanIdlePause } from '../../../../../../dist/human/mouse.js';

export function milestoneSteps({ page, form }) {
  const { fillSelector } = form;
function extraMilestone(t, idx, base) {
  return {
    nazwa: `Uzupełniający punkt weryfikacyjny ${t.nr}.${idx + 1}: kompletność rezultatów zadania`,
    parametry: `Punkt porządkujący potwierdza kompletność i spójność rezultatów opisanych w zadaniu ${t.nr}. Obejmuje sprawdzenie, że artefakty kodowe, surowe wyniki ewaluacji, konfiguracje eksperymentów, logi uruchomień, checklisty odbioru i metadane wersji są kompletne, zarchiwizowane w repozytorium projektu i powiązane z właściwymi kamieniami milowymi. Zakres jest zgodny z opisem zadania i nie rozszerza merytorycznego zakresu prac B+R poza rezultaty wskazane w harmonogramie.`,
    weryfikacja: `Weryfikacja polega na przeglądzie repozytorium projektowego, identyfikatorów commitów, logów CI, surowych wyników benchmarków, konfiguracji modeli, checksumów artefaktów, protokołów odbioru i list kontrolnych przypisanych do zadania ${t.nr}. Kierownik prac B+R potwierdza kompletność dowodów, a kierownik zarządzający zgodność wpisu z harmonogramem rzeczowo-finansowym i rejestrem artefaktów projektu.`,
    wplyw: `Nieosiągnięcie punktu oznacza potrzebę uzupełnienia dokumentacji lub powiązania dowodów z rezultatami zadania. Nie zmienia celu projektu, ale opóźnia formalne potwierdzenie kompletności rezultatów, dlatego wymaga korekty dokumentacji, ponownego przeglądu oraz akceptacji kierownika B+R i kierownika zarządzającego projektem.`,
  };
}

async function fillEmptyMilestones(t) {
  const names = await page.evaluate(() => Array.from(document.querySelectorAll('textarea[name^="kamienie_milowe_kolekcja["]')).map((e) => ({ name: e.name, len: e.value.length })));
  const indexes = [...new Set(names.map((x) => Number((x.name.match(/kamienie_milowe_kolekcja\[(\d+)\]/) || [])[1])).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  const filled = [];
  for (const idx of indexes) {
    const current = await page.evaluate((i) => {
      const fields = ['kamienie_milowe_nazwa', 'kamienie_milowe_parametry', 'kamienie_milowe_opis_weryfikacji', 'kamienie_milowe_opis_wplywu'];
      return fields.map((f) => document.querySelector(`textarea[name="kamienie_milowe_kolekcja[${i}].${f}"]`)?.value.length || 0);
    }, idx);
    if (current.every((len) => len > 0)) continue;
    const base = t.milestones[idx] || extraMilestone(t, idx, t.milestones[idx % Math.max(1, t.milestones.length)]);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_nazwa"]`, base.nazwa);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_parametry"]`, base.parametry);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_weryfikacji"]`, base.weryfikacja);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_wplywu"]`, base.wplyw);
    filled.push(idx);
  }
  return filled;
}

async function fillAllMilestones(t) {
  const names = await page.evaluate(() => Array.from(document.querySelectorAll('textarea[name^="kamienie_milowe_kolekcja["]')).map((e) => e.name));
  const indexes = [...new Set(names.map((name) => Number((name.match(/kamienie_milowe_kolekcja\[(\d+)\]/) || [])[1])).filter((n) => Number.isInteger(n)))].sort((a, b) => a - b);
  const filled = [];
  for (const idx of indexes) {
    const base = t.milestones[idx] || extraMilestone(t, idx, t.milestones[idx % Math.max(1, t.milestones.length)]);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_nazwa"]`, base.nazwa);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_parametry"]`, base.parametry);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_weryfikacji"]`, base.weryfikacja);
    await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_wplywu"]`, base.wplyw);
    filled.push(idx);
  }
  return filled;
}

async function addMilestone(t, idx = 0) {
  await humanClickLocator(page, page.locator('button:visible').filter({ hasText: /^Dodaj kolejny$/ }).first()) // allow-raw-playwright: add nested milestone row
  await humanIdlePause('long');
  const m = t.milestones[idx] || extraMilestone(t, idx);
  await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_nazwa"]`, m.nazwa);
  await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_parametry"]`, m.parametry);
  await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_weryfikacji"]`, m.weryfikacja);
  await fillSelector(`[name="kamienie_milowe_kolekcja[${idx}].kamienie_milowe_opis_wplywu"]`, m.wplyw);
  return idx;
}
  return { extraMilestone, fillEmptyMilestones, fillAllMilestones, addMilestone };
}
