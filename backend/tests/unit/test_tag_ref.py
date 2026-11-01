"""How a tag is stored next to the release before's built-in-only column (#400)."""

import uuid

import pytest

from app.models.tag_ref import effective_tag, is_stale, set_tag
from app.tags_api import TagCreate, TagPatch, check_tag_shape

CUSTOM = uuid.uuid4()


def test_a_built_in_tag_is_stored_as_itself() -> None:
    assert set_tag("study") == ("study", None)
    assert effective_tag("study", None) == "study"


def test_a_custom_tag_is_stored_as_work_plus_its_id() -> None:
    assert set_tag(str(CUSTOM)) == ("work", CUSTOM)
    assert effective_tag("work", CUSTOM) == str(CUSTOM)


def test_a_built_in_tag_next_to_an_id_was_edited_by_the_release_before() -> None:
    assert effective_tag("study", CUSTOM) == "study"
    assert is_stale("study", CUSTOM) and is_stale(None, CUSTOM)
    assert not is_stale("work", CUSTOM) and not is_stale("study", None)


@pytest.mark.parametrize(
    "value", ["Work", "", "x", str(CUSTOM).upper(), str(CUSTOM).replace("-", "")]
)
def test_only_built_in_identifiers_and_canonical_ids_pass_the_shape_check(value: str) -> None:
    with pytest.raises(ValueError, match="Unknown tag"):
        check_tag_shape(value)


def test_shape_check_accepts_identifiers_and_ids() -> None:
    assert check_tag_shape("meditation") == "meditation"
    assert check_tag_shape(str(CUSTOM)) == str(CUSTOM)


def test_names_are_trimmed_and_line_breaks_become_one_space() -> None:
    assert TagCreate(name="  a\r\n\nb ", color="blue").name == "a b"
    assert TagPatch(name="\nx\n").name == "x"
