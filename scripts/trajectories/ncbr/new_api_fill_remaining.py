#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Fill remaining NEW NCBR sections through the current project's API.

This intentionally does not use the archived Kimi project/version constants.
It fetches APPLICATION_DATA from the live new project before every API save.
"""

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

from playwright.async_api import async_playwright


BASE = "https://lsi2.ncbr.gov.pl"
PROJECT_ID = "8bab411b-170f-438d-a148-f71eb0ab2c9f"
VERSION_ID = "f27396d8-1857-4f0b-a692-5e5d6cbc22b1"
CDP_URL = "http://127.0.0.1:9223"
SRC = Path("/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent")
REF = SRC / "DO_NOT_RUN_quarantine_20260620"
OLD_WISENT_KEY = "37932151-ac1b-4afa-9c17-3854317af0ae"

sys.path.insert(0, str(REF))
sys.path.insert(0, str(SRC))

from cdp_api import new_id  # noqa: E402
from save_remaining_sections import parse_10_1, parse_10_2, parse_10_3, parse_10_4  # noqa: E402
from save_2_3_fetch import prepare_2_3_payload  # noqa: E402
from save_2_4_fetch import prepare_2_4_payload  # noqa: E402
from save_4_1_collection import parse_4_1, make_member_row  # noqa: E402
from save_6_1_collection import parse_6_1, RODZAJ_ZADANIA  # noqa: E402
from save_6_financials import actual_cost_rows, indirect_cost_rows  # noqa: E402
from save_9_1_collection import parse_9_1  # noqa: E402
from save_9_2_collection import parse_9_2  # noqa: E402


SECTIONS = {
    "2.3": "c5dbdc83-5baf-4866-b3d8-4da3ae553865",
    "2.4": "94fb1adb-38a5-4949-b4c1-b0a79472bfd3",
    "4.1": "5af236aa-03b2-4650-b5a2-95c299dfeeaf",
    "6.1": "566c735c-8ad0-406f-a948-f3ea921c2cc7",
    "6.3": "fb417879-403e-4241-a202-ec23c6a6b866",
    "6.5": "bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b",
    "9.1": "8ff0ee28-01e7-4a83-96c0-e11049be2c70",
    "9.2": "e95d0c23-8a39-4d56-96fa-ace3e4f0d23a",
    "10.1": "e5bd23d7-9d4d-4f2e-948a-97c95041ef18",
    "10.2": "51455d27-6e3d-4629-9cc6-2a124f5432c8",
    "10.3": "256ac98a-bb3c-4715-ad13-e8dbcd3f94f4",
    "10.4": "4e260fae-c455-41ce-bba3-d0df2a8767fd",
}


def replace_value(value, old, new):
    if value == old:
        return new
    if isinstance(value, list):
        return [replace_value(v, old, new) for v in value]
    if isinstance(value, dict):
        return {k: replace_value(v, old, new) for k, v in value.items()}
    return value


def flatten_rows(collection):
    rows = []
    if isinstance(collection, dict):
        rows.extend(collection.get("rows") or [])
        for group in collection.get("groups") or []:
            if isinstance(group, dict):
                rows.extend(group.get("rows") or [])
    elif isinstance(collection, list):
        rows.extend(collection)
    return rows


class CurrentSession:
    def __init__(self):
        self.playwright = None
        self.browser = None
        self.page = None
        self.app_data = None

    async def __aenter__(self):
        self.playwright = await async_playwright().start()
        self.browser = await self.playwright.chromium.connect_over_cdp(CDP_URL)
        self.page = await self._select_page()
        await self.ensure_origin()
        self.app_data = await self.load_app_data()
        return self

    async def __aexit__(self, exc_type, exc, tb):
        if self.playwright:
            await self.playwright.stop()

    async def _select_page(self):
        fallback = None
        for context in self.browser.contexts:
            for page in context.pages:
                fallback = fallback or page
                if not page.url.startswith(BASE):
                    continue
                status = await page.evaluate(
                    """async (url) => {
                        const res = await fetch(url, {credentials: 'include', headers: {'Accept': 'application/json'}});
                        return res.status;
                    }""",
                    f"{BASE}/api/beneficiary/project/{PROJECT_ID}/get-user-permissions",
                )
                if status == 200:
                    return page
        if fallback:
            return fallback
        raise RuntimeError("No browser page available")

    async def ensure_origin(self):
        if not self.page.url.startswith(BASE):
            await self.page.goto(f"{BASE}/projekt/{PROJECT_ID}", wait_until="domcontentloaded", timeout=120000)
            await self.page.wait_for_timeout(1000)

    async def fetch(self, url, method="GET", body=None, headers=None):
        await self.ensure_origin()
        default_headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if headers:
            default_headers.update(headers)
        return await self.page.evaluate(
            """async ({url, method, headers, body}) => {
                const res = await fetch(url, {
                    method,
                    credentials: 'include',
                    headers,
                    body: body === null ? undefined : JSON.stringify(body),
                });
                const text = await res.text();
                let data = null;
                try { data = JSON.parse(text); } catch {}
                return {status: res.status, text, data};
            }""",
            {"url": url, "method": method, "headers": default_headers, "body": body},
        )

    async def load_app_data(self):
        res = await self.fetch(f"{BASE}/api/beneficiary/projects/{PROJECT_ID}")
        if res["status"] != 200:
            raise RuntimeError(f"project DTO fetch failed: {res['status']} {res['text'][:300]}")
        return {"workflow": None, "user": None, "project": res["data"]}

    def scalar_url(self):
        return f"{BASE}/api/beneficiary/project-versions/{VERSION_ID}/project-registries"

    def collection_url(self, section_id, collection_code, row_id=None):
        base = f"{BASE}/api/beneficiary/project-versions/{VERSION_ID}/project-sections/{section_id}/registries-values/{collection_code}/collection-objects"
        return f"{base}/{row_id}" if row_id else base

    async def get_values(self, section_id):
        return await self.fetch(f"{BASE}/api/beneficiary/project-versions/{VERSION_ID}/project-sections/{section_id}/registries-values")

    async def get_project_dictionary_key(self, section_id, code_path, field_name="nazwa_skrocona"):
        url = (
            f"{BASE}/api/beneficiary/project-versions/{VERSION_ID}/project-sections/{section_id}/project-dictionary"
            f"?codePath={code_path}&codePathIsObjectName=false&fieldName={field_name}&withMainModule=false"
        )
        res = await self.fetch(url)
        members = ((res.get("data") or {}).get("hydra:member") or [])
        if members:
            return members[0].get("key"), members
        return None, res

    async def patch_scalar(self, section_id, form_data):
        payload = {
            "actionEventName": None,
            "formData": {**form_data, "APPLICATION_DATA": self.app_data, "sectionId": section_id},
            "isDraft": True,
            "sectionId": section_id,
        }
        return await self.fetch(
            self.scalar_url(),
            method="PATCH",
            body=payload,
            headers={"Content-Type": "application/merge-patch+json"},
        )

    async def create_row(self, section_id, collection_code, row, separator_code=None):
        form_data = dict(row)
        if separator_code:
            form_data[separator_code] = None
        form_data["collectionCode"] = collection_code
        form_data["APPLICATION_DATA"] = self.app_data
        return await self.fetch(self.collection_url(section_id, collection_code), method="POST", body={"actionEventName": None, "formData": form_data})

    async def update_row(self, section_id, collection_code, row_id, row):
        form_data = dict(row)
        form_data["collectionCode"] = collection_code
        form_data["APPLICATION_DATA"] = self.app_data
        return await self.fetch(
            self.collection_url(section_id, collection_code, row_id),
            method="PATCH",
            body={"actionEventName": None, "formData": form_data},
            headers={"Content-Type": "application/merge-patch+json"},
        )

    async def delete_row(self, section_id, collection_code, row_id):
        return await self.fetch(self.collection_url(section_id, collection_code, row_id), method="DELETE")

    async def delete_all_rows(self, section_id, collection_code):
        values = await self.get_values(section_id)
        fields = (values.get("data") or {}).get("fields") or {}
        rows = flatten_rows(fields.get(collection_code))
        deleted = 0
        for row in rows:
            row_id = row.get("id") or row.get("uuid")
            if not row_id:
                continue
            res = await self.delete_row(section_id, collection_code, row_id)
            if res["status"] in (200, 204):
                deleted += 1
            else:
                print(f"WARN delete {collection_code}/{row_id}: {res['status']} {res['text'][:200]}")
        return deleted

    async def create_and_update_rows(self, section_id, collection_code, rows, separator_code=None):
        deleted = await self.delete_all_rows(section_id, collection_code)
        print(f"{collection_code}: deleted {deleted}")
        created = []
        previous_id = None
        for row in rows:
            row = dict(row)
            row["previousItemId"] = previous_id
            create = await self.create_row(section_id, collection_code, row, separator_code=separator_code)
            ok = create["status"] in (200, 201, 204)
            print(f"  create: {create['status']} ok={ok}")
            if not ok:
                print(create["text"][:800])
                continue
            server_id = (((create.get("data") or {}).get("fields") or {}).get("id") or row.get("id"))
            update_row = {"id": server_id, **row}
            update = await self.update_row(section_id, collection_code, server_id, update_row)
            update_ok = update["status"] in (200, 201, 204)
            print(f"  update {server_id}: {update['status']} ok={update_ok}")
            if not update_ok:
                print(update["text"][:800])
            else:
                created.append(server_id)
                previous_id = server_id
        return created


def rows_from_group_payload(payload, collection_code):
    form_data = payload["formData"]
    return flatten_rows(form_data.get(collection_code))


async def current_wisent_key(session):
    key, _ = await session.get_project_dictionary_key(
        SECTIONS["4.1"],
        "nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta",
    )
    if key:
        return key
    for section_id, collection in [
        (SECTIONS["5.1"], "premia_za_skuteczna_wspolprace_miedzy_przedsiebiorstwami_kolekcja"),
        (SECTIONS["1.3"], "podmioty_realizujace_projekt_kolekcja"),
    ]:
        values = await session.get_values(section_id)
        fields = (values.get("data") or {}).get("fields") or {}
        for row in flatten_rows(fields.get(collection)):
            for value in row.values():
                if isinstance(value, str) and re.match(r"^[0-9a-f-]{36}$", value):
                    return value
    raise RuntimeError("Could not discover current Wisent applicant key")


async def save_2_3(session):
    payload = prepare_2_3_payload()
    form = payload["formData"]
    res = await session.patch_scalar(SECTIONS["2.3"], form)
    print(f"2.3 full payload: {res['status']}")
    return res["status"]


async def save_2_4(session):
    payload = prepare_2_4_payload()
    res = await session.patch_scalar(SECTIONS["2.4"], payload["formData"])
    print(f"2.4 full payload: {res['status']}")
    return res["status"]


async def save_10(session):
    parsed = parse_10_1()
    scalar = await session.patch_scalar(SECTIONS["10.1"], parsed["scalar"])
    print(f"10.1 scalar: {scalar['status']}")
    products = await session.create_and_update_rows(
        SECTIONS["10.1"],
        "dostepnosc_produktu_uslugi_w_projekcie_kolekcja",
        parsed["products"],
    )
    print(f"10.1 products: {len(products)}")
    r2 = await session.patch_scalar(SECTIONS["10.2"], parse_10_2())
    r3 = await session.patch_scalar(SECTIONS["10.3"], parse_10_3())
    print(f"10.2 scalar: {r2['status']}")
    print(f"10.3 scalar: {r3['status']}")
    parsed_10_4 = parse_10_4()
    legal = await session.create_and_update_rows(
        SECTIONS["10.4"],
        "zgodnosc_projektu_z_przepisami_w_zakresie_ochrony_srodowiska_kolekcja",
        parsed_10_4["legal_rows"],
        separator_code="zgodnosc_projektu_z_przepisami_w_zakresie_ochrony_srodowiska_kolekcja_separator",
    )
    scalar_10_4 = await session.patch_scalar(SECTIONS["10.4"], parsed_10_4["scalar"])
    print(f"10.4 legal: {len(legal)} scalar: {scalar_10_4['status']}")


async def save_9(session):
    # 9.1 updates existing mandatory rows.
    parsed_91 = parse_9_1()
    values = await session.get_values(SECTIONS["9.1"])
    rows = flatten_rows(((values.get("data") or {}).get("fields") or {}).get("wskazniki_produktu_kolekcja"))
    by_name = {r.get("nazwa_wskaznika"): r for r in rows}
    updated = 0
    for item in parsed_91:
        existing = by_name.get(item["nazwa_wskaznika"])
        if not existing:
            print(f"9.1 missing: {item['nazwa_wskaznika']}")
            continue
        res = await session.update_row(SECTIONS["9.1"], "wskazniki_produktu_kolekcja", existing["id"], {"id": existing["id"], **item})
        if res["status"] in (200, 201, 204):
            updated += 1
        else:
            print(f"9.1 update failed {res['status']} {res['text'][:300]}")
    print(f"9.1 updated: {updated}/{len(parsed_91)}")

    # 9.2 updates mandatory rows and recreates custom rows.
    mandatory, custom = parse_9_2()
    values = await session.get_values(SECTIONS["9.2"])
    rows = flatten_rows(((values.get("data") or {}).get("fields") or {}).get("wskazniki_rezultatu_kolekcja"))
    by_name = {r.get("nazwa_wskaznika"): r for r in rows}
    upd = 0
    for item in mandatory:
        existing = by_name.get(item["nazwa_wskaznika"])
        if not existing:
            print(f"9.2 missing mandatory: {item['nazwa_wskaznika']}")
            continue
        row = {
            "id": existing["id"],
            "nazwa_wskaznika": item["nazwa_wskaznika"],
            "rok_bazowy": str(item["rok_bazowy"]) if item["rok_bazowy"] is not None else None,
            "rok_osiagniecia_wartosci_docelowej": str(item["rok_osiagniecia_wartosci_docelowej"]) if item["rok_osiagniecia_wartosci_docelowej"] is not None else None,
            "wartosc_docelowa": str(item["wartosc_docelowa"]) if item["wartosc_docelowa"] is not None else None,
            "opis_metodologii": item["opis_metodologii"],
            "opis_sposobu_weryfikacji": item["opis_sposobu_weryfikacji"],
        }
        res = await session.update_row(SECTIONS["9.2"], "wskazniki_rezultatu_kolekcja", existing["id"], row)
        if res["status"] in (200, 201, 204):
            upd += 1
        else:
            print(f"9.2 update failed {res['status']} {res['text'][:300]}")
    deleted = 0
    for row in rows:
        if (row.get("row_options") or {}).get("allowDelete"):
            res = await session.delete_row(SECTIONS["9.2"], "wskazniki_rezultatu_kolekcja", row["id"])
            if res["status"] in (200, 204):
                deleted += 1
    previous_id = None
    fresh = await session.get_values(SECTIONS["9.2"])
    fresh_rows = flatten_rows(((fresh.get("data") or {}).get("fields") or {}).get("wskazniki_rezultatu_kolekcja"))
    if fresh_rows:
        previous_id = fresh_rows[-1].get("id")
    created = []
    for item in custom:
        row_id = new_id()
        row = {
            "id": row_id,
            "previousItemId": previous_id,
            "nazwa_wskaznika": item["nazwa_wskaznika"],
            "jednostka_miary": item["jednostka_miary"],
            "rok_bazowy": str(item["rok_bazowy"]) if item["rok_bazowy"] is not None else None,
            "wartosc_bazowa": str(item["wartosc_bazowa"]) if item["wartosc_bazowa"] is not None else None,
            "rok_osiagniecia_wartosci_docelowej": str(item["rok_osiagniecia_wartosci_docelowej"]) if item["rok_osiagniecia_wartosci_docelowej"] is not None else None,
            "wartosc_docelowa": str(item["wartosc_docelowa"]) if item["wartosc_docelowa"] is not None else None,
            "opis_metodologii": item["opis_metodologii"],
            "opis_sposobu_weryfikacji": item["opis_sposobu_weryfikacji"],
        }
        res = await session.create_row(SECTIONS["9.2"], "wskazniki_rezultatu_kolekcja", row, separator_code="wskazniki_rezultatu_separator")
        if res["status"] in (200, 201, 204):
            created.append(row_id)
            previous_id = row_id
        else:
            print(f"9.2 custom create failed {res['status']} {res['text'][:300]}")
    print(f"9.2 mandatory updated: {upd}/{len(mandatory)} deleted custom: {deleted} created custom: {len(created)}")


async def save_4_1(session, wisent_key):
    data = parse_4_1()
    rows = []
    previous_id = None
    for member in data["members"]:
        row = make_member_row(member, previous_id)
        row = replace_value(row, OLD_WISENT_KEY, wisent_key)
        rows.append(row)
        previous_id = row.get("id")
    created = await session.create_and_update_rows(
        SECTIONS["4.1"],
        "zespol_projektowy_kolekcja",
        rows,
        separator_code="zespol_projektowy_kolekcja_separator",
    )
    scalar = {
        "zespol_projektowy_separator": None,
        "udzial_procentowy_kobiet_w_kluczowym_zespole_projektowym": data["udzial"],
        "pozostaly_personel_br": data["pozostaly"],
        "personel_planowany_br": data["personel"],
        "sposob_zarzadzania_projektem": data["sposob"],
    }
    res = await session.patch_scalar(SECTIONS["4.1"], scalar)
    print(f"4.1 members: {len(created)} scalar: {res['status']}")


def make_task_row(task, wisent_key, previous_id):
    return {
        "previousItemId": previous_id,
        "nazwa_i_rodzaj_zadania": task["nazwa_i_rodzaj"],
        "numer_zadania": task["numer"],
        "nazwa_zadania": task["nazwa"],
        "koszty_posrednie": "Tak" if task["koszty_posrednie"] == "Tak" else "Nie",
        "startDate": task["start"],
        "endDate": task["end"],
        "rodzaj_zadania": RODZAJ_ZADANIA.get(task["rodzaj"], task["rodzaj"]),
        "nazwa_skrocona_wnioskodawcy_samodzielnego_lidera_konsorcjum_konsorcjanta": [wisent_key] if task["nazwa_skrocona"] else [],
        "zakres_planowanych_prac_br": task["zakres"],
        "szczegolowy_opis_prac": task["szczegolowy"],
        "kamienie_milowe_kolekcja": task["milestones"],
    }


async def save_6(session, wisent_key):
    tasks = parse_6_1()
    rows = []
    previous_id = None
    for task in tasks:
        row = make_task_row(task, wisent_key, previous_id)
        rows.append(row)
        previous_id = row.get("id")
    created = await session.create_and_update_rows(
        SECTIONS["6.1"],
        "zadania_kolekcja",
        rows,
        separator_code="zadania_kolekcja_separator",
    )
    print(f"6.1 tasks: {len(created)}")
    values = await session.get_values(SECTIONS["6.1"])
    task_rows = flatten_rows(((values.get("data") or {}).get("fields") or {}).get("zadania_kolekcja"))
    by_num = {int(r.get("numer_zadania")): r.get("id") for r in task_rows if r.get("numer_zadania") is not None and r.get("id")}
    print(f"6.1 task ids by number: {by_num}")
    if not all(k in by_num for k in (1, 2, 5)):
        raise RuntimeError("Missing task ids required for 6.3 financial rows")

    import save_6_financials as fin  # noqa: WPS433

    replacements = {
        fin.TASK_1: by_num[1],
        fin.TASK_2: by_num[2],
        fin.TASK_5: by_num[5],
        OLD_WISENT_KEY: wisent_key,
    }

    def remap(row):
        out = row
        for old, new in replacements.items():
            out = replace_value(out, old, new)
        return out

    actual = [remap(row) for row in actual_cost_rows()]
    indirect = [remap(row) for row in indirect_cost_rows()]
    created_actual = await session.create_and_update_rows(
        SECTIONS["6.3"],
        "wydatki_rzeczywiste_kolekcja",
        actual,
        separator_code="wydatki_rzeczywiste_kolekcja_separator",
    )
    created_indirect = await session.create_and_update_rows(
        SECTIONS["6.5"],
        "koszty_posrednie_kolekcja",
        indirect,
        separator_code="koszty_posrednie_kolekcja_separator",
    )
    print(f"6.3 actual costs: {len(created_actual)}")
    print(f"6.5 indirect costs: {len(created_indirect)}")


async def verify_counts(session):
    checks = {
        "4.1": ("zespol_projektowy_kolekcja", SECTIONS["4.1"]),
        "6.1": ("zadania_kolekcja", SECTIONS["6.1"]),
        "6.3": ("wydatki_rzeczywiste_kolekcja", SECTIONS["6.3"]),
        "6.5": ("koszty_posrednie_kolekcja", SECTIONS["6.5"]),
        "9.1": ("wskazniki_produktu_kolekcja", SECTIONS["9.1"]),
        "9.2": ("wskazniki_rezultatu_kolekcja", SECTIONS["9.2"]),
        "10.1": ("dostepnosc_produktu_uslugi_w_projekcie_kolekcja", SECTIONS["10.1"]),
        "10.4": ("zgodnosc_projektu_z_przepisami_w_zakresie_ochrony_srodowiska_kolekcja", SECTIONS["10.4"]),
    }
    out = {}
    for label, (collection, section_id) in checks.items():
        values = await session.get_values(section_id)
        fields = (values.get("data") or {}).get("fields") or {}
        out[label] = len(flatten_rows(fields.get(collection)))
    print("VERIFY_COUNTS " + json.dumps(out, ensure_ascii=False, sort_keys=True))


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=["nonfinancial", "finance", "all", "verify"], default="nonfinancial")
    args = parser.parse_args()

    async with CurrentSession() as session:
        wisent_key = await current_wisent_key(session)
        print(f"current Wisent key: {wisent_key}")
        if args.phase in ("nonfinancial", "all"):
            await save_2_3(session)
            await save_2_4(session)
            await save_10(session)
            await save_9(session)
            await save_4_1(session, wisent_key)
        if args.phase in ("finance", "all"):
            await save_6(session, wisent_key)
        await verify_counts(session)


if __name__ == "__main__":
    asyncio.run(main())
