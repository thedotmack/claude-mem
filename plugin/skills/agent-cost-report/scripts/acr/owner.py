"""Report owner for the name-keyed detectors and human reviews.

Order: an explicit name (the ``--owner-name`` flag), then ``ACR_OWNER_NAME``, then
``git config user.name``. A blank explicit value or a blank ``ACR_OWNER_NAME`` forces
the name-free patterns and does not consult git. Nothing here defaults to a person.
"""
import os
import subprocess

_MISSING = object()
_pin = _MISSING
_git_cached = False
_git_value = None


def clean(value):
    if value is None: return None
    text = str(value).strip()
    return text or None


def git_user_name():
    """``git config --get user.name``, or None when git has no name or cannot run."""
    try:
        r = subprocess.run(["git", "config", "--get", "user.name"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0: return None
    return clean(r.stdout)


def _cached_git():
    global _git_cached, _git_value
    if not _git_cached:
        _git_value = git_user_name()
        _git_cached = True
    return _git_value


def resolve(explicit=_MISSING, environ=None, git_lookup=None):
    """The owner name, or None when unset. ``explicit`` (including "") wins over the environment."""
    if explicit is not _MISSING:
        return clean(explicit)
    env = os.environ if environ is None else environ
    if "ACR_OWNER_NAME" in env:
        return clean(env["ACR_OWNER_NAME"])
    lookup = _cached_git if git_lookup is None else git_lookup
    try:
        found = lookup()
    except (OSError, subprocess.SubprocessError):
        return None
    return clean(found)


def name():
    """Name in effect for this process: a scoped override, else :func:`resolve`."""
    if _pin is not _MISSING:
        return clean(_pin)
    return resolve()


class scoped:
    """Pin an explicit owner for one command. None leaves environment and git resolution alone."""

    def __init__(self, explicit):
        self.explicit = explicit

    def __enter__(self):
        global _pin
        self._prev = _pin
        if self.explicit is not None:
            _pin = self.explicit
        return name()

    def __exit__(self, *exc):
        global _pin
        _pin = self._prev
        return False
