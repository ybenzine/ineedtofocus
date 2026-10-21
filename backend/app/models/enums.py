"""Allowed values (product_decisions F7, F2-F4, AC6.3). Stored as lower-case text."""

from enum import StrEnum


class Tag(StrEnum):
    WORK = "work"
    STUDY = "study"
    NAP = "nap"
    READ = "read"
    MEDITATION = "meditation"
    EXERCISE = "exercise"


class Mode(StrEnum):
    COUNTDOWN = "countdown"
    POMODORO = "pomodoro"
    UNLIMITED = "unlimited"


class Status(StrEnum):
    COMPLETED = "completed"
    ENDED_EARLY = "ended_early"


TAGS: tuple[str, ...] = tuple(t.value for t in Tag)
MODES: tuple[str, ...] = tuple(m.value for m in Mode)
STATUSES: tuple[str, ...] = tuple(s.value for s in Status)

GOAL_MAX_LENGTH = 120
# Unlimited-timer reminder choices in minutes (AC4.2); NULL means Off.
REMINDER_MINUTES: tuple[int, ...] = (15, 30, 45, 60, 90, 120)


def in_list(column: str, values: tuple[str, ...] | tuple[int, ...]) -> str:
    """SQL `column IN (...)` text for a CHECK constraint (values are our own constants)."""
    return f"{column} IN ({', '.join(repr(v) for v in values)})"
