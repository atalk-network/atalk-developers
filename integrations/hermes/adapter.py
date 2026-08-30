"""Directory-plugin entry point used by `hermes plugins install`."""

from pathlib import Path
import sys

_SOURCE = str(Path(__file__).parent / "src")
if _SOURCE not in sys.path:
    sys.path.insert(0, _SOURCE)

from atalk_hermes import register
from atalk_hermes.adapter import AtalkAdapter

__all__ = ["AtalkAdapter", "register"]
