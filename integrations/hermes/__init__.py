"""Hermes directory-plugin entry point."""


def register(ctx):
    """Load Hermes-only imports when the host activates the plugin."""
    from .adapter import register as register_platform

    return register_platform(ctx)


__all__ = ["register"]
