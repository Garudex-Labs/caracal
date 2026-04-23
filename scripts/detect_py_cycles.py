#!/usr/bin/env python3
"""Find import cycles in the caracal/ package (static AST, internal imports only).

Skips imports under ``if TYPE_CHECKING:`` and records the most specific ``caracal.*`` target
per import (not parent package prefixes) to avoid false cycles.
"""
from __future__ import annotations

import argparse
import ast
import os
import sys
from collections import defaultdict
from typing import DefaultDict, Dict, List, Set, Tuple


def path_to_module(py_path: str, caracal_dir: str) -> str:
    rel = os.path.relpath(py_path, caracal_dir)
    rel = rel.replace(os.sep, "/")
    if rel == "__init__.py":
        return "caracal"
    if rel.endswith("/__init__.py"):
        return "caracal." + rel[: -len("/__init__.py")].replace("/", ".")
    if rel.endswith(".py"):
        return "caracal." + rel[: -len(".py")].replace("/", ".")
    raise ValueError(repr(py_path))


def is_type_checking_if(node: ast.stmt) -> bool:
    if not isinstance(node, ast.If):
        return False
    t = node.test
    if isinstance(t, ast.Name) and t.id == "TYPE_CHECKING":
        return True
    if isinstance(t, ast.Attribute) and t.attr == "TYPE_CHECKING":
        if isinstance(t.value, ast.Name) and t.value.id in ("typing", "typing_extensions"):
            return True
    return False


def leaf_in_modules(name: str, modules: Set[str]) -> str | None:
    while name:
        if name in modules:
            return name
        if "." not in name:
            break
        name = name.rsplit(".", 1)[0]
    return None


def package_for_module(mod: str, is_init: bool) -> str:
    if is_init:
        return mod
    if "." not in mod:
        return mod
    return mod.rsplit(".", 1)[0]


def resolve_relative(
    mod: str, is_init: bool, level: int, relmodule: str | None, modules: Set[str]
) -> List[str]:
    """Resolve ``from .`` / ``from ..`` to ``caracal.*`` module names that exist in ``modules``."""
    if level == 0:
        return []
    base = package_for_module(mod, is_init)
    for _ in range(level - 1):
        if "." not in base:
            break
        base = base.rsplit(".", 1)[0]
    if not relmodule:
        return [m] if (m := leaf_in_modules(base, modules)) else []
    full = f"{base}.{relmodule}" if base else relmodule
    m = leaf_in_modules(full, modules)
    return [m] if m else []


def add_import_from_edges(
    n: ast.ImportFrom,
    mod: str,
    is_init: bool,
    modules: Set[str],
    out: Set[str],
) -> None:
    if n.module and n.module not in (None, "caracal") and not n.module.startswith("caracal."):
        return
    if n.level and n.module is None:  # relative: from .x / from . import
        targets: List[str] = []
        if n.module:
            targets.extend(resolve_relative(mod, is_init, n.level, n.module, modules))
        else:
            # from . import a, b  ->  package.a, etc.
            pkg = package_for_module(mod, is_init)
            for _ in range(n.level - 1):
                if "." not in pkg:
                    break
                pkg = pkg.rsplit(".", 1)[0]
            for alias in n.names:
                if alias.name == "*":
                    continue
                full = f"{pkg}.{alias.name}" if pkg else alias.name
                m = leaf_in_modules(full, modules)
                if m:
                    targets.append(m)
        for t in targets:
            out.add(t)
        return
    if n.level and n.module:  # from ...pkg.mod (relative + absolute tail)
        rel = resolve_relative(mod, is_init, n.level, n.module, modules)
        for t in rel:
            out.add(t)
        return
    if n.module and (n.module == "caracal" or n.module.startswith("caracal.")):
        # from caracal.x.y import z  ->  edge to caracal.x.y.z (submodule) or caracal.x.y
        base = n.module
        for alias in n.names:
            if alias.name == "*":
                m = leaf_in_modules(base, modules)
                if m:
                    out.add(m)
                continue
            sub = f"{base}.{alias.name}"
            t = leaf_in_modules(sub, modules) or leaf_in_modules(base, modules)
            if t:
                out.add(t)


def add_import_edges(n: ast.Import, modules: Set[str], out: Set[str]) -> None:
    for alias in n.names:
        name = alias.name
        if name == "caracal" or name.startswith("caracal."):
            m = leaf_in_modules(name, modules)
            if m:
                out.add(m)


def load_graph(
    caracal_dir: str, *, include_type_checking: bool = False
) -> Tuple[Set[str], DefaultDict[str, Set[str]]]:
    modules: Set[str] = set()
    for root, _dirs, files in os.walk(caracal_dir):
        for name in files:
            if not name.endswith(".py"):
                continue
            p = os.path.join(root, name)
            if "/." in p.replace("\\", "/"):
                continue
            modules.add(path_to_module(p, caracal_dir))

    graph: DefaultDict[str, Set[str]] = defaultdict(set)
    for root, _dirs, files in os.walk(caracal_dir):
        for name in files:
            if not name.endswith(".py"):
                continue
            p = os.path.join(root, name)
            if "/." in p.replace("\\", "/"):
                continue
            mod = path_to_module(p, caracal_dir)
            is_init = name == "__init__.py"
            try:
                with open(p, "r", encoding="utf-8") as f:
                    tree = ast.parse(f.read(), filename=p)
            except SyntaxError as e:
                print(f"SKIP syntax error {p}: {e}", file=sys.stderr)
                continue
            out: Set[str] = set()
            skip_tc = not include_type_checking

            for st in tree.body:
                if isinstance(st, ast.If) and is_type_checking_if(st):
                    if skip_tc:
                        continue
                    for line in st.body:
                        visit_stmt(line)
                    for line in st.orelse:
                        visit_stmt(line)
                    continue
                if isinstance(st, ast.Import):
                    add_import_edges(st, modules, out)
                elif isinstance(st, ast.ImportFrom):
                    add_import_from_edges(st, mod, is_init, modules, out)

            def visit_stmt(st: ast.AST) -> None:
                if isinstance(st, ast.If) and is_type_checking_if(st):
                    if skip_tc:
                        for x in st.orelse:
                            visit_stmt(x)
                    else:
                        for line in st.body + st.orelse:
                            visit_stmt(line)
                    return
                if isinstance(st, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                    for line in st.body:
                        visit_stmt(line)
                elif isinstance(st, ast.Try):
                    for line in st.body:
                        visit_stmt(line)
                    for h in st.handlers:
                        for line in h.body:
                            visit_stmt(line)
                    for line in st.orelse:
                        visit_stmt(line)
                    for line in st.finalbody:
                        visit_stmt(line)
                elif isinstance(st, (ast.For, ast.AsyncFor, ast.While)):
                    for line in st.body + st.orelse:
                        visit_stmt(line)
                elif isinstance(st, (ast.With, ast.AsyncWith)):
                    for line in st.body:
                        visit_stmt(line)
                elif isinstance(st, ast.Import):
                    add_import_edges(st, modules, out)
                elif isinstance(st, ast.ImportFrom):
                    add_import_from_edges(st, mod, is_init, modules, out)

            for st in tree.body:
                visit_stmt(st)

            for t in out:
                if t != mod:
                    graph[mod].add(t)
    return modules, graph


def sccs(graph: DefaultDict[str, Set[str]], nodes: Set[str]) -> List[List[str]]:
    index = 0
    stack: List[str] = []
    low: Dict[str, int] = {}
    indices: Dict[str, int] = {}
    on_stack: Set[str] = set()
    result: List[List[str]] = []

    def strongconnect(v: str) -> None:
        nonlocal index
        indices[v] = index
        low[v] = index
        index += 1
        stack.append(v)
        on_stack.add(v)
        for w in graph.get(v, ()):
            if w not in nodes:
                continue
            if w not in indices:
                strongconnect(w)
                low[v] = min(low[v], low[w])
            elif w in on_stack:
                low[v] = min(low[v], indices[w])
        if low[v] == indices[v]:
            scc: List[str] = []
            while True:
                w = stack.pop()
                on_stack.remove(w)
                scc.append(w)
                if w == v:
                    break
            result.append(scc)

    for v in nodes:
        if v not in indices:
            strongconnect(v)
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--include-type-checking",
        action="store_true",
        help="Also count imports under ``if TYPE_CHECKING:`` (for static / typing-only cycles).",
    )
    args = ap.parse_args()
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    caracal_dir = os.path.join(root, "caracal")
    if not os.path.isdir(caracal_dir):
        print("No caracal/ directory next to this script", file=sys.stderr)
        sys.exit(1)
    modules, graph = load_graph(
        caracal_dir, include_type_checking=args.include_type_checking
    )
    cycles = [
        s
        for s in sccs(graph, modules)
        if len(s) > 1 or (len(s) == 1 and s[0] in graph.get(s[0], set()))
    ]
    if not cycles:
        mode = "including TYPE_CHECKING imports" if args.include_type_checking else "runtime imports (TYPE_CHECKING blocks skipped)"
        print(f"No import cycles ({mode}, leaf targets).")
        return
    print(f"Found {len(cycles)} cycle component(s) (SCC):")
    for i, comp in enumerate(sorted(cycles, key=lambda c: (len(c), c[0])), 1):
        cset = set(comp)
        print(f"\n--- Component {i} ({len(comp)} modules) ---")
        for a in sorted(comp):
            internal = sorted(graph.get(a, set()) & cset)
            if internal:
                print(f"  {a} -> {', '.join(internal)}")


if __name__ == "__main__":
    main()
