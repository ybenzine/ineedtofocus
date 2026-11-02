"""Allowed values (product_decisions F7, F2-F4, AC6.3). Stored as lower-case text."""

from enum import StrEnum


class Tag(StrEnum):
    WORK = "work"
    STUDY = "study"
    NAP = "nap"
    READ = "read"
    MEDITATION = "meditation"
    EXERCISE = "exercise"


# Display names of the built-in tags; a custom tag may not take one, ignoring case (AC7.4).
TAG_DISPLAY_NAMES: tuple[str, ...] = ("Work", "Study", "Nap", "Read", "Meditation", "Exercise")
# The palette of tag colours (AC7.5), in palette order.
COLORS: tuple[str, ...] = ("indigo", "blue", "teal", "green", "yellow", "orange", "red", "pink")
TAG_NAME_MAX_LENGTH = 24
MAX_CUSTOM_TAGS_IN_USE = 20
MAX_CUSTOM_TAGS_TOTAL = 100


class Theme(StrEnum):
    """Colour theme (#214); "system" follows the device's light/dark setting."""

    SYSTEM = "system"
    DARK = "dark"
    LIGHT = "light"


class Mode(StrEnum):
    COUNTDOWN = "countdown"
    POMODORO = "pomodoro"
    UNLIMITED = "unlimited"


class Status(StrEnum):
    COMPLETED = "completed"
    ENDED_EARLY = "ended_early"


TAGS: tuple[str, ...] = tuple(t.value for t in Tag)
THEMES: tuple[str, ...] = tuple(t.value for t in Theme)
MODES: tuple[str, ...] = tuple(m.value for m in Mode)
STATUSES: tuple[str, ...] = tuple(s.value for s in Status)

GOAL_MAX_LENGTH = 120
# Unlimited-timer reminder choices in minutes (AC4.2); NULL means Off.
REMINDER_MINUTES: tuple[int, ...] = (15, 30, 45, 60, 90, 120)


# Calendar export settings (AC12.8, F14).
CALENDAR_TITLE_MAX_LENGTH = 120
CALENDAR_TITLE_DEFAULT = "{tag}: {goal}"
CALENDAR_NAME_MAX_LENGTH = 60
CALENDAR_NAME_DEFAULT = "I Need To Focus"
CALENDAR_MIN_MINUTES: tuple[int, ...] = (0, 5, 10, 15)
# Built-in tags plus the 100 custom tags an account can ever have (removed ones included).
CALENDAR_EXCLUDED_TAGS_MAX = 106


def in_list(column: str, values: tuple[str, ...] | tuple[int, ...]) -> str:
    """SQL `column IN (...)` text for a CHECK constraint (values are our own constants)."""
    return f"{column} IN ({', '.join(repr(v) for v in values)})"
