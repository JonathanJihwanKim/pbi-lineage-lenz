"""
model-lenz — deprecated. Replaced by PBI Lineage Lenz.

    npx pbi-lineage-lenz handoff ./MyReport -o handoff.html
    https://github.com/JonathanJihwanKim/pbi-lineage-lenz

The last working release is 0.4.0: `pip install model-lenz==0.4.0`.
"""

import warnings

__version__ = "0.5.1"

__all__ = ["__version__"]

# Anyone importing the library rather than running the CLI gets the same message.
# A warning rather than a raised error: an import that explodes inside somebody's
# unrelated tooling is a worse way to learn this than a line in the log.
warnings.warn(
    "model-lenz is no longer maintained and this release does nothing. "
    "It is replaced by PBI Lineage Lenz: `npx pbi-lineage-lenz`. "
    "See https://github.com/JonathanJihwanKim/pbi-lineage-lenz — "
    "or pin the last working release with `pip install model-lenz==0.4.0`.",
    DeprecationWarning,
    stacklevel=2,
)
