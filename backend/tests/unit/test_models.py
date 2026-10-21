"""Pure checks on the model definitions (no database)."""

from app.models import MODES, STATUSES, TAGS, Base, FocusSession
from app.models.enums import GOAL_MAX_LENGTH, in_list


def test_ac7_1_allowed_tags() -> None:
    assert TAGS == ("work", "study", "nap", "read", "meditation", "exercise")


def test_ac6_3_modes_and_statuses() -> None:
    assert MODES == ("countdown", "pomodoro", "unlimited")
    assert STATUSES == ("completed", "ended_early")


def test_ac7_3_goal_limit_is_120() -> None:
    assert GOAL_MAX_LENGTH == 120
    assert FocusSession.__table__.c.goal.type.length == 120  # type: ignore[attr-defined]


def test_in_list_renders_sql() -> None:
    assert in_list("x", ("a", "b")) == "x IN ('a', 'b')"
    assert in_list("n", (1, 2)) == "n IN (1, 2)"


def test_ac6_3_session_columns() -> None:
    cols = set(FocusSession.__table__.c.keys())
    assert {
        "id",
        "user_id",
        "mode",
        "tag",
        "goal",
        "started_at",
        "ended_at",
        "focus_seconds",
        "paused_seconds",
        "status",
        "mode_config",
        "blocks_completed",
        "archived_at",
    } <= cols


def test_all_tables_registered() -> None:
    assert set(Base.metadata.tables) == {
        "users",
        "user_settings",
        "focus_sessions",
        "youtube_recent_links",
    }


def test_session_id_has_no_server_default() -> None:
    # The client generates the UUID (AC13.4), so the database must not.
    assert FocusSession.__table__.c.id.server_default is None
