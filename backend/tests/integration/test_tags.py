"""Custom tags (#400, AC7.4-AC7.9) against a real, migrated, throwaway Postgres."""

import datetime as dt
import logging
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from fastapi import APIRouter
from fastapi.testclient import TestClient
from httpx import Response
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.deps import DbSession
from app.logging_config import JsonFormatter
from app.models import TAGS, Tag
from tests.integration.conftest import MakeClient, run
from tests.integration.test_auth import _exec, _scalar
from tests.integration.test_history import history
from tests.integration.test_history import save as save_at
from tests.integration.test_sessions import make_session

pytestmark = pytest.mark.integration

COLORS = ["indigo", "blue", "teal", "green", "yellow", "orange", "red", "pink"]
SECRET = "Quarterly merger"


@pytest.fixture(autouse=True)
def _fixed_now(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.sessions._now", lambda: dt.datetime(2030, 1, 1, tzinfo=dt.UTC))


def add(c: TestClient, name: str, color: str = "indigo") -> Response:
    r: Response = c.post("/api/tags", json={"name": name, "color": color})
    return r


def made(c: TestClient, name: str, color: str = "indigo") -> dict[str, Any]:
    r = add(c, name, color)
    assert r.status_code == 201, r.text
    body: dict[str, Any] = r.json()
    return body


def remove(c: TestClient, tag_id: str) -> Response:
    r: Response = c.post(f"/api/tags/{tag_id}/remove")
    return r


def conflict(r: Response, kind: str, field: str) -> None:
    assert r.status_code == 409, r.text
    error = r.json()["error"]
    assert error["code"] == "conflict"
    (detail,) = error["details"]
    assert (detail["type"], detail["field"]) == (kind, field)
    assert detail["message"] == error["message"]


def user_id(url: str, email: str = "ada@example.com") -> str:
    return str(run(_scalar(url, f"SELECT id FROM users WHERE email = '{email}'"))[0][0])


def fill(url: str, uid: str, in_use: int, removed: int) -> None:
    """Insert tags straight into the database: `in_use` in use and `removed` removed."""
    rows = [(f"Filler {i}", "NULL") for i in range(in_use)]
    rows += [(f"Gone {i}", "now()") for i in range(removed)]
    values = ", ".join(f"('{uid}', '{n}', 'blue', {r})" for n, r in rows)
    run(_exec(url, f"INSERT INTO custom_tags (user_id, name, color, removed_at) VALUES {values}"))


# --- GET /api/tags (AC 2) ---------------------------------------------------------------


def test_list_requires_sign_in(make_client: MakeClient) -> None:
    with make_client() as c:
        assert c.get("/api/tags").status_code == 401
        assert add(c, "Chores").status_code == 401
        assert c.patch(f"/api/tags/{uuid.uuid4()}", json={"color": "red"}).status_code == 401
        assert remove(c, str(uuid.uuid4())).status_code == 401


def test_list_is_empty_for_a_new_account_and_oldest_first(ada: TestClient) -> None:
    assert ada.get("/api/tags").json() == {"tags": []}
    first, second, third = (made(ada, n) for n in ("Beta", "Alpha", "Gamma"))
    remove(ada, second["id"])
    tags = ada.get("/api/tags").json()["tags"]
    assert [t["id"] for t in tags] == [first["id"], second["id"], third["id"]]  # removed included
    assert set(tags[0]) == {"id", "name", "color", "created_at", "removed_at"}
    assert [t["removed_at"] is None for t in tags] == [True, False, True]


def test_list_shows_only_the_accounts_own_tags(ada: TestClient, bob: TestClient) -> None:
    made(ada, "Chores")
    assert bob.get("/api/tags").json() == {"tags": []}
    made(bob, "Chores")  # the same name in another account is fine
    assert len(ada.get("/api/tags").json()["tags"]) == 1


# --- POST /api/tags: validation (AC7.4, AC7.5) ----------------------------------------------


def test_create_returns_201_with_a_server_generated_id(ada: TestClient) -> None:
    r = add(ada, "Chores", "teal")
    assert r.status_code == 201
    body = r.json()
    assert (body["name"], body["color"], body["removed_at"]) == ("Chores", "teal", None)
    assert str(uuid.UUID(body["id"])) == body["id"]
    assert body["created_at"].endswith("Z")
    assert ada.get("/api/tags").json()["tags"] == [body]


@pytest.mark.parametrize(
    ("sent", "stored"),
    [
        ("  Deep work  ", "Deep work"),
        ("Deep\nwork", "Deep work"),
        ("Deep\r\n\r\nwork", "Deep work"),
        ("\nDeep\u2028work\n", "Deep work"),
        ("x" * 24, "x" * 24),
        ("é" * 24, "é" * 24),
    ],
)
def test_ac7_4_name_is_trimmed_and_line_breaks_become_one_space(
    ada: TestClient, sent: str, stored: str
) -> None:
    assert made(ada, sent)["name"] == stored


@pytest.mark.parametrize("name", ["", "   ", "\n\n", "x" * 25, "a\x00b", None, 7])
def test_ac7_4_bad_names_are_422(ada: TestClient, name: Any) -> None:
    r = ada.post("/api/tags", json={"name": name, "color": "red"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"
    assert ada.get("/api/tags").json() == {"tags": []}


def test_ac7_4_a_lone_surrogate_in_a_name_is_422(ada: TestClient) -> None:
    raw = r'{"name": "a\ud800b", "color": "red"}'
    r = ada.post("/api/tags", content=raw, headers={"content-type": "application/json"})
    assert r.status_code == 422
    assert ada.get("/api/tags").json() == {"tags": []}


@pytest.mark.parametrize("color", ["Indigo", "purple", "#ff0000", "", None, 3])
def test_ac7_5_colour_outside_the_palette_is_422(ada: TestClient, color: Any) -> None:
    assert ada.post("/api/tags", json={"name": "Chores", "color": color}).status_code == 422


@pytest.mark.parametrize("color", COLORS)
def test_ac7_5_every_palette_colour_is_accepted(ada: TestClient, color: str) -> None:
    assert made(ada, f"Tag {color}", color)["color"] == color


def test_create_rejects_missing_and_unknown_fields(ada: TestClient) -> None:
    assert ada.post("/api/tags", json={"name": "Chores"}).status_code == 422
    assert ada.post("/api/tags", json={"color": "red"}).status_code == 422
    assert ada.post("/api/tags", json={"name": "A", "color": "red", "id": "x"}).status_code == 422


# --- POST /api/tags: conflicts (AC7.4) -----------------------------------------------------


@pytest.mark.parametrize("name", ["Work", "work", "STUDY", "Nap", "read", "Meditation", "EXERCISE"])
def test_ac7_4_built_in_names_are_taken_ignoring_case(ada: TestClient, name: str) -> None:
    r = add(ada, name)
    conflict(r, "name_taken", "name")
    assert r.json()["error"]["message"] == "A tag with this name already exists."


def test_ac7_4_in_use_names_are_taken_ignoring_case(ada: TestClient, bob: TestClient) -> None:
    made(ada, "Chores")
    conflict(add(ada, "chores"), "name_taken", "name")
    conflict(add(ada, " CHORES "), "name_taken", "name")
    assert add(bob, "chores").status_code == 201  # another account is unaffected


def test_ac7_4_limit_of_20_in_use(ada: TestClient, app_url: str) -> None:
    fill(app_url, user_id(app_url), in_use=19, removed=0)
    assert add(ada, "The twentieth").status_code == 201
    r = add(ada, "One too many")
    conflict(r, "limit_in_use", "body")
    assert r.json()["error"]["message"] == (
        "You can have up to 20 tags of your own. Remove one to add another."
    )
    assert len(ada.get("/api/tags").json()["tags"]) == 20


def test_ac7_4_limit_of_100_in_all_counts_removed_tags(ada: TestClient, app_url: str) -> None:
    fill(app_url, user_id(app_url), in_use=10, removed=90)
    r = add(ada, "The 101st")
    conflict(r, "limit_total", "body")
    assert r.json()["error"]["message"] == (
        "You've reached the limit of 100 tags, including removed ones."
    )
    assert len(ada.get("/api/tags").json()["tags"]) == 100


def test_checks_run_in_order_name_taken_then_limit_in_use_then_limit_total(
    ada: TestClient, app_url: str
) -> None:
    fill(app_url, user_id(app_url), in_use=20, removed=80)
    assert ada.get("/api/tags").json()["tags"][0]["name"] == "Filler 0"
    conflict(add(ada, "filler 0"), "name_taken", "name")  # before the limits
    conflict(add(ada, "Work"), "name_taken", "name")
    conflict(add(ada, "Fresh"), "limit_in_use", "body")  # 20 in use and 100 in all: in use first
    assert ada.post("/api/tags", json={"name": "", "color": "red"}).status_code == 422  # first


# --- POST /api/tags: bringing a removed tag back (AC7.7) -------------------------------------


def test_ac7_7_a_removed_name_brings_the_tag_back_keeping_its_name(ada: TestClient) -> None:
    tag = made(ada, "Deep Work", "blue")
    assert remove(ada, tag["id"]).status_code == 200
    r = add(ada, "  deep work ", "pink")
    assert r.status_code == 200
    back = r.json()
    assert back["id"] == tag["id"]
    assert (back["name"], back["color"], back["removed_at"]) == ("Deep Work", "pink", None)
    assert back["created_at"] == tag["created_at"]
    assert ada.get("/api/tags").json()["tags"] == [back]


def test_ac7_7_bringing_back_is_refused_at_20_in_use(ada: TestClient, app_url: str) -> None:
    tag = made(ada, "Old one")
    remove(ada, tag["id"])
    fill(app_url, user_id(app_url), in_use=20, removed=0)
    conflict(add(ada, "old one"), "limit_in_use", "body")
    still = [t for t in ada.get("/api/tags").json()["tags"] if t["id"] == tag["id"]]
    assert still[0]["removed_at"] is not None


def test_ac7_7_bringing_back_is_allowed_at_100_in_all(ada: TestClient, app_url: str) -> None:
    fill(app_url, user_id(app_url), in_use=5, removed=94)
    tag = made(ada, "Old one")  # the 100th
    remove(ada, tag["id"])
    r = add(ada, "OLD ONE", "red")
    assert r.status_code == 200 and r.json()["id"] == tag["id"]
    assert len(ada.get("/api/tags").json()["tags"]) == 100


# --- uniqueness under races (AC7.4) ---------------------------------------------------------


def test_ac7_4_two_devices_creating_the_same_name_make_one_tag(ada: TestClient) -> None:
    with ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda i: add(ada, "RACE" if i % 2 else "race"), range(6)))
    assert sorted(r.status_code for r in results) == [201, 409, 409, 409, 409, 409]
    for r in results:
        if r.status_code == 409:
            assert r.json()["error"]["details"][0]["type"] == "name_taken"
    assert len(ada.get("/api/tags").json()["tags"]) == 1


def test_ac7_4_the_database_refuses_two_names_that_differ_only_in_case(
    ada: TestClient, app_url: str
) -> None:
    uid = user_id(app_url)
    run(
        _exec(
            app_url, f"INSERT INTO custom_tags (user_id, name, color) VALUES ('{uid}', 'A', 'red')"
        )
    )
    with pytest.raises(IntegrityError):
        run(
            _exec(
                app_url,
                f"INSERT INTO custom_tags (user_id, name, color) VALUES ('{uid}', 'a', 'red')",
            )
        )


# --- PATCH /api/tags/{id} (AC7.6) ---------------------------------------------------------


def test_ac7_6_rename_and_recolour(ada: TestClient) -> None:
    tag = made(ada, "Chores", "red")
    r = ada.patch(f"/api/tags/{tag['id']}", json={"name": " Housework ", "color": "green"})
    assert r.status_code == 200
    assert (r.json()["name"], r.json()["color"]) == ("Housework", "green")
    only_colour = ada.patch(f"/api/tags/{tag['id']}", json={"color": "pink"}).json()
    assert (only_colour["name"], only_colour["color"]) == ("Housework", "pink")
    only_name = ada.patch(f"/api/tags/{tag['id']}", json={"name": "Home"}).json()
    assert (only_name["name"], only_name["color"]) == ("Home", "pink")
    assert only_name["id"] == tag["id"] and only_name["created_at"] == tag["created_at"]


def test_ac7_6_renaming_to_its_own_name_in_another_case_is_allowed(ada: TestClient) -> None:
    tag = made(ada, "Chores")
    r = ada.patch(f"/api/tags/{tag['id']}", json={"name": "CHORES"})
    assert (r.status_code, r.json()["name"]) == (200, "CHORES")


def test_ac7_6_name_clashes_are_name_taken(ada: TestClient) -> None:
    made(ada, "Chores")
    other = made(ada, "Errands")
    for name in ("chores", "Work", "STUDY"):
        r = ada.patch(f"/api/tags/{other['id']}", json={"name": name})
        conflict(r, "name_taken", "name")
        assert r.json()["error"]["message"] == "A tag with this name already exists."
    assert ada.get("/api/tags").json()["tags"][1]["name"] == "Errands"


def test_ac7_6_renaming_to_a_removed_tags_name_is_removed_name_taken(ada: TestClient) -> None:
    gone = made(ada, "Old")
    other = made(ada, "Errands")
    remove(ada, gone["id"])
    r = ada.patch(f"/api/tags/{other['id']}", json={"name": "old"})
    conflict(r, "removed_name_taken", "name")
    assert r.json()["error"]["message"] == (
        "A removed tag has this name. Add a tag with this name to bring it back."
    )


def test_ac7_6_patching_a_removed_tag_is_removed(ada: TestClient) -> None:
    gone = made(ada, "Old")
    remove(ada, gone["id"])
    r = ada.patch(f"/api/tags/{gone['id']}", json={"color": "red"})
    conflict(r, "removed", "body")
    assert r.json()["error"]["message"] == "This tag was removed on another device."
    # `removed` is checked before the name clashes.
    conflict(ada.patch(f"/api/tags/{gone['id']}", json={"name": "Work"}), "removed", "body")


def test_ac7_6_patch_checks_run_404_then_422_then_the_conflicts(
    ada: TestClient, bob: TestClient
) -> None:
    mine = made(ada, "Mine")
    theirs = made(bob, "Theirs")
    bad = {"name": "x" * 99, "color": "nope"}
    assert ada.patch(f"/api/tags/{uuid.uuid4()}", json=bad).status_code == 404
    assert ada.patch(f"/api/tags/{theirs['id']}", json=bad).status_code == 404  # not Ada's
    assert ada.patch(f"/api/tags/{mine['id']}", json=bad).status_code == 422
    remove(ada, mine["id"])
    assert ada.patch(f"/api/tags/{mine['id']}", json=bad).status_code == 422  # before `removed`
    assert ada.patch(f"/api/tags/{mine['id']}", json={"color": "red"}).status_code == 409


@pytest.mark.parametrize(
    "body",
    [{}, {"name": None}, {"color": None}, {"name": ""}, {"color": "nope"}, {"id": "x"}],
)
def test_ac7_6_bad_patches_are_422(ada: TestClient, body: dict[str, Any]) -> None:
    tag = made(ada, "Chores")
    assert ada.patch(f"/api/tags/{tag['id']}", json=body).status_code == 422
    assert ada.get("/api/tags").json()["tags"] == [tag]


def test_patch_and_remove_of_another_accounts_tag_are_404(ada: TestClient, bob: TestClient) -> None:
    theirs = made(bob, "Theirs")
    assert ada.patch(f"/api/tags/{theirs['id']}", json={"color": "red"}).status_code == 404
    assert remove(ada, theirs["id"]).status_code == 404
    assert bob.get("/api/tags").json()["tags"] == [theirs]


# --- POST /api/tags/{id}/remove (AC7.7) -----------------------------------------------------


def test_ac7_7_remove_is_idempotent_and_changes_no_session_or_setting(ada: TestClient) -> None:
    tag = made(ada, "Chores")
    session = ada.post("/api/sessions", json=make_session(tag=tag["id"])).json()
    assert ada.patch("/api/settings", json={"last_tag": tag["id"]}).status_code == 200
    first = remove(ada, tag["id"])
    assert first.status_code == 200 and first.json()["removed_at"] is not None
    second = remove(ada, tag["id"])
    assert second.status_code == 200 and second.json() == first.json()
    assert ada.get("/api/settings").json()["last_tag"] == tag["id"]
    assert history(ada, view="all")["sessions"][0]["tag"] == session["tag"] == tag["id"]


def test_unknown_tag_id_is_404(ada: TestClient) -> None:
    assert remove(ada, str(uuid.uuid4())).status_code == 404


# --- tag values in sessions, settings and history (AC 6, AC 7) -------------------------------


def test_ac7_4_a_session_keeps_a_custom_tag_through_save_edit_and_archive(
    ada: TestClient,
) -> None:
    tag = made(ada, "Chores")
    saved = ada.post("/api/sessions", json=make_session(tag=tag["id"]))
    assert (saved.status_code, saved.json()["tag"]) == (201, tag["id"])
    sid = saved.json()["id"]
    assert ada.patch(f"/api/sessions/{sid}", json={"tag": "study"}).json()["tag"] == "study"
    assert ada.patch(f"/api/sessions/{sid}", json={"tag": tag["id"]}).json()["tag"] == tag["id"]
    assert ada.post(f"/api/sessions/{sid}/archive").json()["tag"] == tag["id"]
    assert ada.get("/api/sessions/archived").json()["sessions"][0]["tag"] == tag["id"]
    assert ada.post(f"/api/sessions/{sid}/restore").json()["tag"] == tag["id"]


def test_ac6_removed_tags_are_still_accepted_everywhere(ada: TestClient) -> None:
    tag = made(ada, "Chores")
    remove(ada, tag["id"])
    one = ada.post("/api/sessions", json=make_session(tag=tag["id"]))
    assert one.status_code == 201 and one.json()["tag"] == tag["id"]
    sync = ada.post("/api/sessions/sync", json={"sessions": [make_session(tag=tag["id"])]})
    assert sync.json()["created"] == 1
    sid = ada.post("/api/sessions", json=make_session()).json()["id"]
    assert ada.patch(f"/api/sessions/{sid}", json={"tag": tag["id"]}).status_code == 200
    assert ada.patch("/api/settings", json={"last_tag": tag["id"]}).status_code == 200
    assert history(ada, view="all", tag=[tag["id"]])["session_count"] == 3


def test_ac6_unknown_and_foreign_tag_ids_are_422_with_the_same_message(
    ada: TestClient, bob: TestClient
) -> None:
    theirs = made(bob, "Theirs")
    ghost = str(uuid.uuid4())
    sid = ada.post("/api/sessions", json=make_session()).json()["id"]
    messages: set[str] = set()
    for value in (theirs["id"], ghost):
        for r in (
            ada.post("/api/sessions", json=make_session(tag=value)),
            ada.patch(f"/api/sessions/{sid}", json={"tag": value}),
            ada.patch("/api/settings", json={"last_tag": value}),
            ada.get("/api/history", params={"view": "all", "tz": "UTC", "tag": value}),
        ):
            assert r.status_code == 422, r.text
            (detail,) = r.json()["error"]["details"]
            messages.add(detail["message"])
            assert value not in r.text
    assert len(messages) == 1  # nothing tells another account's id from a made-up one
    assert ada.get("/api/settings").json()["last_tag"] is None


def test_ac6_sync_rejects_foreign_ids_per_item_and_saves_the_rest(
    ada: TestClient, bob: TestClient
) -> None:
    mine = made(ada, "Mine")
    theirs = made(bob, "Theirs")
    batch = [
        make_session(tag=mine["id"]),
        make_session(tag=theirs["id"]),
        make_session(tag=str(uuid.uuid4())),
        make_session(tag="study"),
    ]
    r = ada.post("/api/sessions/sync", json={"sessions": batch}).json()
    assert [x["status"] for x in r["results"]] == ["created", "rejected", "rejected", "created"]
    assert [x["error"]["code"] for x in r["results"] if x["error"]] == ["validation_error"] * 2
    reasons = {x["error"]["details"][0]["message"] for x in r["results"] if x["error"]}
    assert len(reasons) == 1
    assert [x["error"]["details"][0]["field"] for x in r["results"] if x["error"]] == ["tag"] * 2
    assert r["results"][0]["session"]["tag"] == mine["id"]


@pytest.mark.parametrize("value", ["Work", "WORK", "Chores", "", "not-a-uuid"])
def test_ac6_display_names_and_junk_stay_422(ada: TestClient, value: str) -> None:
    made(ada, "Chores")
    assert ada.post("/api/sessions", json=make_session(tag=value)).status_code == 422
    assert ada.patch("/api/settings", json={"last_tag": value}).status_code == 422


def test_ac6_uppercase_uuid_is_not_the_canonical_id(ada: TestClient) -> None:
    tag = made(ada, "Chores")
    r = ada.post("/api/sessions", json=make_session(tag=tag["id"].upper()))
    assert r.status_code == 422


def test_ac6_last_tag_round_trips_and_goes_back_to_none_or_a_built_in(ada: TestClient) -> None:
    tag = made(ada, "Chores")
    assert ada.patch("/api/settings", json={"last_tag": tag["id"]}).json()["last_tag"] == tag["id"]
    assert ada.get("/api/settings").json()["last_tag"] == tag["id"]
    assert ada.patch("/api/settings", json={"last_tag": "nap"}).json()["last_tag"] == "nap"
    assert ada.patch("/api/settings", json={"last_tag": tag["id"]}).status_code == 200
    assert ada.patch("/api/settings", json={"last_tag": None}).json()["last_tag"] is None


def test_ac7_history_filters_and_groups_custom_tags_like_built_in_ones(ada: TestClient) -> None:
    a, b = made(ada, "Alpha"), made(ada, "Beta")
    save_at(ada, "2026-10-23T08:00:00", 30, tag=a["id"])
    save_at(ada, "2026-10-23T09:00:00", 10, tag=a["id"])
    save_at(ada, "2026-10-23T10:00:00", 40, tag=b["id"])
    save_at(ada, "2026-10-23T11:00:00", 15, tag="work")
    save_at(ada, "2026-10-23T12:00:00", 5, tag="study")
    everything = history(ada, view="day", date="2026-10-23")
    assert [(t["tag"], t["focus_seconds"] // 60, t["sessions"]) for t in everything["tags"]] == [
        (a["id"], 40, 2),
        (b["id"], 40, 1),
        ("work", 15, 1),
        ("study", 5, 1),
    ]
    only_a = history(ada, view="day", date="2026-10-23", tag=[a["id"]])
    assert only_a["session_count"] == 2 and only_a["total_focus_seconds"] == 40 * 60
    assert {s["tag"] for s in only_a["sessions"]} == {a["id"]}
    work_only = history(ada, view="day", date="2026-10-23", tag=["work"])
    assert [s["tag"] for s in work_only["sessions"]] == ["work"]  # not the custom ones
    mixed = history(ada, view="day", date="2026-10-23", tag=["study", b["id"]])
    assert {s["tag"] for s in mixed["sessions"]} == {"study", b["id"]}


def test_ac7_8_breakdown_ties_go_built_in_first_then_custom_oldest_first(
    ada: TestClient,
) -> None:
    older, newer = made(ada, "Older"), made(ada, "Newer")
    for tag in (newer["id"], older["id"], "exercise", "nap", "work"):
        save_at(ada, "2026-10-23T08:00:00", 20, tag=tag)
    tags = [t["tag"] for t in history(ada, view="all")["tags"]]
    assert tags == ["work", "nap", "exercise", older["id"], newer["id"]]
    save_at(ada, "2026-10-23T09:00:00", 1, tag=older["id"])  # more focus time wins over order
    assert history(ada, view="all")["tags"][0]["tag"] == older["id"]


def test_history_filter_includes_removed_tags_and_other_accounts_stay_apart(
    ada: TestClient, bob: TestClient
) -> None:
    tag = made(ada, "Chores")
    save_at(ada, "2026-10-23T08:00:00", 30, tag=tag["id"])
    remove(ada, tag["id"])
    assert history(ada, view="all", tag=[tag["id"]])["session_count"] == 1
    assert history(bob, view="all")["session_count"] == 0
    r = bob.get("/api/history", params={"view": "all", "tz": "UTC", "tag": tag["id"]})
    assert r.status_code == 422 and r.json()["error"]["details"][0]["field"] == "tag.0"


# --- export and deletion (AC 8) ------------------------------------------------------------


def test_ac8_export_has_tags_and_the_same_tag_values_as_the_api(ada: TestClient) -> None:
    live, gone = made(ada, "Live", "teal"), made(ada, "Gone", "red")
    remove(ada, gone["id"])
    sid = ada.post("/api/sessions", json=make_session(tag=live["id"])).json()["id"]
    ada.patch("/api/settings", json={"last_tag": gone["id"]})
    body = ada.get("/api/account/export").json()
    assert body["format_version"] == 1
    assert body["tags"] == ada.get("/api/tags").json()["tags"]
    assert [t["name"] for t in body["tags"]] == ["Live", "Gone"]
    assert body["tags"][1]["removed_at"] is not None
    (session,) = body["sessions"]
    assert (session["id"], session["tag"]) == (sid, live["id"])
    assert "custom_tag_id" not in session and "custom_tag_id" not in body["settings"]
    assert body["settings"]["last_tag"] == gone["id"]


def test_ac8_export_has_only_the_accounts_own_tags(ada: TestClient, bob: TestClient) -> None:
    made(ada, "Mine")
    made(bob, "Theirs")
    assert [t["name"] for t in ada.get("/api/account/export").json()["tags"]] == ["Mine"]
    assert "Theirs" not in ada.get("/api/account/export").text


def test_ac8_deleting_the_account_removes_its_tags_in_the_database(
    ada: TestClient, bob: TestClient, app_url: str
) -> None:
    tag = made(ada, "Chores")
    made(bob, "Theirs")
    ada.post("/api/sessions", json=make_session(tag=tag["id"]))
    ada.patch("/api/settings", json={"last_tag": tag["id"]})
    assert (
        ada.post("/api/account/delete", json={"password": "correct horse battery"}).status_code
        == 204
    )
    assert run(_scalar(app_url, "SELECT count(*) FROM custom_tags"))[0][0] == 1
    assert run(_scalar(app_url, "SELECT count(*) FROM focus_sessions"))[0][0] == 0


# --- migration safety: the release before (AC 1) ----------------------------------------------


def test_ac1_the_release_before_reads_custom_tagged_rows_as_work(
    ada: TestClient, app_url: str
) -> None:
    tag = made(ada, "Chores")
    ada.post("/api/sessions", json=make_session(tag=tag["id"]))
    ada.patch("/api/settings", json={"last_tag": tag["id"]})
    # What the release before reads: only the old columns, parsed with the old enum.
    (session_tag,) = run(_scalar(app_url, "SELECT tag FROM focus_sessions"))[0]
    uid = user_id(app_url)
    sql = f"SELECT last_tag FROM user_settings WHERE user_id = '{uid}'"
    (last_tag,) = run(_scalar(app_url, sql))[0]
    assert Tag(session_tag) is Tag.WORK and Tag(last_tag) is Tag.WORK
    assert session_tag in TAGS and last_tag in TAGS  # the old CHECK constraints hold too


def test_ac1_the_release_before_can_write_sessions_and_delete_an_account_with_tags(
    ada: TestClient, bob: TestClient, app_url: str
) -> None:
    tag = made(ada, "Chores")
    ada.post("/api/sessions", json=make_session(tag=tag["id"]))
    uid = user_id(app_url)
    # An insert that names only the old columns, as the release before does.
    run(
        _exec(
            app_url,
            "INSERT INTO focus_sessions (id, user_id, mode, tag, started_at, ended_at, "
            f"focus_seconds, status) VALUES ('{uuid.uuid4()}', '{uid}', 'countdown', 'nap', "
            "now() - interval '1 hour', now(), 100, 'completed')",
        )
    )
    run(_exec(app_url, f"DELETE FROM users WHERE id = '{uid}'"))  # plain SQL, no ORM
    assert run(_scalar(app_url, "SELECT count(*) FROM custom_tags"))[0][0] == 0
    assert run(_scalar(app_url, "SELECT count(*) FROM focus_sessions"))[0][0] == 0
    assert bob.get("/api/tags").status_code == 200


def test_ac1_a_built_in_edit_made_during_a_rollback_wins_and_clears_the_custom_id(
    ada: TestClient, app_url: str
) -> None:
    tag = made(ada, "Chores")
    sid = ada.post("/api/sessions", json=make_session(tag=tag["id"])).json()["id"]
    ada.patch("/api/settings", json={"last_tag": tag["id"]})
    # The release before sets both to a built-in tag; it knows nothing of the custom id.
    run(_exec(app_url, "UPDATE focus_sessions SET tag = 'study'"))
    run(_exec(app_url, "UPDATE user_settings SET last_tag = 'nap'"))
    assert history(ada, view="all")["sessions"][0]["tag"] == "study"
    assert history(ada, view="all", tag=["study"])["session_count"] == 1
    assert history(ada, view="all", tag=[tag["id"]])["session_count"] == 0
    assert ada.get("/api/settings").json()["last_tag"] == "nap"
    assert ada.get("/api/account/export").json()["sessions"][0]["tag"] == "study"
    kept = "SELECT count(*) FROM {} WHERE custom_tag_id IS NOT NULL"
    assert run(_scalar(app_url, kept.format("focus_sessions")))[0][0] == 1  # reads don't write
    assert run(_scalar(app_url, kept.format("user_settings")))[0][0] == 1
    # The next write of each row clears the custom id.
    assert ada.patch(f"/api/sessions/{sid}", json={"goal": "New goal"}).json()["tag"] == "study"
    assert ada.patch("/api/settings", json={"alert_volume": 10}).json()["last_tag"] == "nap"
    assert run(_scalar(app_url, kept.format("focus_sessions")))[0][0] == 0
    assert run(_scalar(app_url, kept.format("user_settings")))[0][0] == 0


def test_ac1_an_edit_to_work_during_a_rollback_cannot_be_told_apart_and_keeps_the_tag(
    ada: TestClient, app_url: str
) -> None:
    tag = made(ada, "Chores")
    ada.post("/api/sessions", json=make_session(tag=tag["id"]))
    ada.patch("/api/settings", json={"last_tag": tag["id"]})
    run(_exec(app_url, "UPDATE focus_sessions SET tag = 'work'"))
    run(_exec(app_url, "UPDATE user_settings SET last_tag = 'work'"))
    assert history(ada, view="all")["sessions"][0]["tag"] == tag["id"]
    assert ada.get("/api/settings").json()["last_tag"] == tag["id"]


def test_ac1_the_release_before_clearing_last_tag_wins_too(ada: TestClient, app_url: str) -> None:
    tag = made(ada, "Chores")
    ada.patch("/api/settings", json={"last_tag": tag["id"]})
    run(_exec(app_url, "UPDATE user_settings SET last_tag = NULL"))
    assert ada.get("/api/settings").json()["last_tag"] is None


# --- privacy (AC7.9) ------------------------------------------------------------------------


def test_ac7_9_tag_names_never_reach_logs_or_error_bodies(
    ada: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    tag = made(ada, SECRET)
    ada.patch(f"/api/tags/{tag['id']}", json={"name": SECRET + " renamed"})
    clash = add(ada, SECRET.lower() + " renamed")
    assert clash.status_code == 409 and "merger" not in clash.text.lower()
    too_long = add(ada, "Quarterly merger " * 5)
    assert too_long.status_code == 422 and "merger" not in too_long.text.lower()
    remove(ada, tag["id"])
    add(ada, SECRET + " renamed")
    assert "merger" not in caplog.text.lower()
    assert "merger" not in repr([r.__dict__ for r in caplog.records]).lower()


def test_ac7_9_a_unique_name_violation_does_not_leak_the_name_into_the_log_line(
    ada: TestClient, caplog: pytest.LogCaptureFixture
) -> None:
    made(ada, SECRET)
    router = APIRouter()

    @router.get("/api/_dup_tag")
    async def dup_tag(db: DbSession) -> dict[str, str]:
        await db.execute(
            text(
                "INSERT INTO custom_tags (user_id, name, color) "
                "SELECT user_id, upper(name), 'red' FROM custom_tags"
            )
        )
        return {}

    ada.app.include_router(router)  # type: ignore[attr-defined]
    with pytest.raises(IntegrityError):  # the test client re-raises server errors
        ada.get("/api/_dup_tag")
    lines = [JsonFormatter().format(r) for r in caplog.records]
    assert any("custom_tags" in line for line in lines)  # the failure was logged...
    assert not any("merger" in line.lower() for line in lines)  # ...without the name
