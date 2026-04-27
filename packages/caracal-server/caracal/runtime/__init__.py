"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Runtime package namespace shared across Caracal distributions.
"""

from pkgutil import extend_path


__path__ = extend_path(__path__, __name__)