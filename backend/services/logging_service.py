from __future__ import annotations

import json
from pathlib import Path
from typing import Any


MAX_FIELD_LENGTH = 5000


def sanitize(value: Any) -> Any:
    if isinstance(value, str):
        if len(value) > MAX_FIELD_LENGTH:
            return f"{value[:MAX_FIELD_LENGTH]}... [truncated]"
        return value
    if isinstance(value, list):
        return [sanitize(item) for item in value[:100]]
    if isinstance(value, dict):
        return {str(key): sanitize(item) for key, item in value.items()}
    return value


def append_jsonl(log_dir: Path, filename: str, payload: dict[str, Any]) -> Path:
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / filename
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(sanitize(payload), ensure_ascii=False, default=str))
        file.write("\n")
    return path
