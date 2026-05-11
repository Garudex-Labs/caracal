# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# OAuth 2.0 scope-string evaluation per RFC 6749 §3.3.


def has_scope(scope: str, target: str) -> bool:
    if not target:
        return False
    return target in scope.split()
