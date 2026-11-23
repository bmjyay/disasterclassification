"""Load settings from a `.env` file in the project root.

Each line is KEY=value. Blank lines and lines starting with # are ignored, and
values may be wrapped in single or double quotes. Variables already set in the
environment (for example Codespaces secrets) take precedence over the file.
"""

from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_env(path: str | os.PathLike | None = None) -> dict[str, str]:
    """Read the .env file into os.environ without overriding existing values.

    Returns the keys it set (values are never logged).
    """
    env_path = Path(path) if path else ROOT / ".env"
    loaded: dict[str, str] = {}
    if not env_path.is_file():
        return loaded
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[len("export "):].strip()
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        elif " #" in value:
            value = value.split(" #", 1)[0].rstrip()
        if key and value and key not in os.environ:
            os.environ[key] = value
            loaded[key] = value
    return loaded
