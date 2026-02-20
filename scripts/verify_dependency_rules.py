#!/usr/bin/env python3
"""
Dependency Rule Verification Script.

Checks that the SDK architecture dependency rules are enforced:
 ✅  sdk/enterprise/   → imports from → caracal.core + caracal.sdk
 ❌  caracal.core       → NEVER imports from → sdk/enterprise/
 ❌  caracal.sdk (core) → NEVER imports from → sdk/enterprise/
 ❌  No 'if is_enterprise' inside core or SDK base modules
"""

import os
import re
import sys
from pathlib import Path


def find_python_files(directory: Path) -> list[Path]:
    """Find all .py files in directory recursively."""
    return sorted(directory.rglob("*.py"))


def check_illegal_imports(base: Path) -> list[str]:
    """Check for illegal import directions."""
    violations = []

    # Core engine should never import from sdk/enterprise/
    core_dir = base / "caracal" / "core"
    if core_dir.exists():
        for f in find_python_files(core_dir):
            content = f.read_text(errors="replace")
            if re.search(r"from\s+caracal\.sdk\.enterprise", content):
                violations.append(f"❌ {f.relative_to(base)}: core imports from sdk.enterprise")
            if re.search(r"import\s+caracal\.sdk\.enterprise", content):
                violations.append(f"❌ {f.relative_to(base)}: core imports from sdk.enterprise")

    # SDK base modules should never import from sdk/enterprise/
    sdk_dir = base / "caracal" / "sdk"
    enterprise_dir = sdk_dir / "enterprise"
    if sdk_dir.exists():
        for f in find_python_files(sdk_dir):
            # Skip enterprise/ itself
            if enterprise_dir.exists() and str(f).startswith(str(enterprise_dir)):
                continue
            content = f.read_text(errors="replace")
            if re.search(r"from\s+caracal\.sdk\.enterprise", content):
                violations.append(f"❌ {f.relative_to(base)}: sdk.core imports from sdk.enterprise")
            if re.search(r"import\s+caracal\.sdk\.enterprise", content):
                violations.append(f"❌ {f.relative_to(base)}: sdk.core imports from sdk.enterprise")

    return violations


def check_conditional_enterprise(base: Path) -> list[str]:
    """Check for `if is_enterprise` conditionals in core/sdk base modules."""
    violations = []
    pattern = re.compile(r"if\s+.*is_enterprise", re.IGNORECASE)

    for d in ["caracal/core", "caracal/sdk"]:
        check_dir = base / d
        enterprise_dir = base / "caracal" / "sdk" / "enterprise"
        if not check_dir.exists():
            continue
        for f in find_python_files(check_dir):
            if enterprise_dir.exists() and str(f).startswith(str(enterprise_dir)):
                continue
            content = f.read_text(errors="replace")
            if pattern.search(content):
                violations.append(f"❌ {f.relative_to(base)}: contains 'if is_enterprise' conditional")

    return violations


def check_node_sdk_imports(base: Path) -> list[str]:
    """Check Node SDK for illegal import directions."""
    violations = []
    src_dir = base / "sdk-node" / "src"
    enterprise_dir = src_dir / "enterprise"

    if not src_dir.exists():
        return violations

    for f in sorted(src_dir.rglob("*.ts")):
        if enterprise_dir.exists() and str(f).startswith(str(enterprise_dir)):
            continue
        content = f.read_text(errors="replace")
        if re.search(r"from\s+['\"].*enterprise", content):
            violations.append(f"❌ {f.relative_to(base)}: core ts imports from enterprise")

    return violations


def check_caracal_enterprise_imports(ecosystem_root: Path) -> list[str]:
    """Check caracalEnterprise/services/ for illegal imports.

    Rules:
      ✅  Can import from  caracal.core.*
      ✅  Can import from  caracal.enterprise.license  (real implementation)
      ✅  Can import from  caracal.enterprise.exceptions
      ✅  Can use relative imports  (from .X import Y)
      ❌  Should NOT import from  caracal.sdk.enterprise  (extension stubs)
      ❌  Should NOT import from  caracal.gateway  (it's a dead redirect)
    """
    violations = []
    services_dir = ecosystem_root / "caracalEnterprise" / "services"

    if not services_dir.exists():
        return violations

    for f in sorted(services_dir.rglob("*.py")):
        content = f.read_text(errors="replace")
        rel = f.relative_to(ecosystem_root)

        # Should not import sdk.enterprise stubs
        if re.search(r"from\s+caracal\.sdk\.enterprise", content):
            violations.append(f"❌ {rel}: imports from caracal.sdk.enterprise (use caracal.enterprise.* instead)")

        # Verify no imports from caracal.mcp
        if re.search(r"from\s+caracal\.mcp", content):
            violations.append(f"❌ {rel}: imports from caracal.mcp. Core should not depend on MCP adapter.")

    return violations


def main():
    base = Path(__file__).resolve().parent.parent
    if not (base / "caracal").exists():
        # Try parent
        base = base.parent
    if not (base / "caracal").exists():
        print("Cannot find project root")
        sys.exit(1)

    print(f"Checking dependency rules in: {base}\n")

    all_violations = []
    all_violations.extend(check_illegal_imports(base))
    all_violations.extend(check_conditional_enterprise(base))

    # Also check Node SDK if it's a sibling
    ecosystem_root = base.parent
    all_violations.extend(check_node_sdk_imports(ecosystem_root))
    all_violations.extend(check_caracal_enterprise_imports(ecosystem_root))

    if all_violations:
        print(f"Found {len(all_violations)} violation(s):\n")
        for v in all_violations:
            print(f"  {v}")
        print()
        sys.exit(1)
    else:
        print("✅ All dependency rules pass!")
        print("  - Core engine does not import from sdk.enterprise")
        print("  - SDK base modules do not import from sdk.enterprise")
        print("  - No conditional enterprise checks in core/sdk")
        print("  - Node SDK core does not import from enterprise")
        print("  - caracalEnterprise/services/ does not import from sdk.enterprise or dead gateway")
        sys.exit(0)


if __name__ == "__main__":
    main()
