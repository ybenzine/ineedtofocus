"""How a tag is stored next to the release before's built-in-only column (#400).

A built-in tag is stored as its identifier with no custom tag id. A custom tag is stored as
`work` plus its id, so the release before, which only knows the six built-ins, reads it as
Work. A row whose `tag` is not `work` while a custom id is set was changed to a built-in tag
by the release before during a rollback: that edit wins, so it reads as the built-in tag and
the next write of the row clears the id (`set_tag`, or `clear_stale_custom_tag`).
"""

import uuid

from app.models.enums import TAGS

STORED_FOR_CUSTOM = "work"


def effective_tag(tag: str, custom_tag_id: uuid.UUID | None) -> str:
    if custom_tag_id is not None and tag == STORED_FOR_CUSTOM:
        return str(custom_tag_id)
    return tag


def set_tag(value: str) -> tuple[str, uuid.UUID | None]:
    """(`tag`, `custom_tag_id`) to store for an API tag value, already validated."""
    if value in TAGS:
        return value, None
    return STORED_FOR_CUSTOM, uuid.UUID(value)


def is_stale(tag: str | None, custom_tag_id: uuid.UUID | None) -> bool:
    """True when the release before replaced a custom tag with a built-in one."""
    return custom_tag_id is not None and tag != STORED_FOR_CUSTOM
