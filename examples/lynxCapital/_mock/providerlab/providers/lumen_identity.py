"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Lumen Identity domain: LynxCapital's internal directory and IAM platform for employees, org structure, RBAC roles, groups, and service accounts.
"""
from __future__ import annotations

from _mock.providerlab.data import generators as gen
from _mock.providerlab.providers import base
from _mock.providerlab.providers.base import Ctx, DomainError

ID = "lumen-identity"


@base.seeder(ID)
def seed(state: base.State) -> None:
    directory = gen.lumen_directory(ID)
    for table, rows in directory.items():
        state.tables[table] = rows


def _resolve_user(ctx: Ctx, key: str = "userId") -> dict:
    ctx.require(key)
    ref = ctx.payload[key]
    users = ctx.state.table("users")
    user = users.get(ref)
    if user is None:
        ref_l = str(ref).lower()
        user = next((u for u in users.values()
                     if u["username"].lower() == ref_l
                     or u["workEmail"].lower() == ref_l
                     or u["userPrincipalName"].lower() == ref_l), None)
    if user is None:
        raise DomainError(404, "user_not_found", str(ref))
    return user


def _effective_access(ctx: Ctx, user: dict) -> dict:
    roles = ctx.state.table("roles")
    groups = ctx.state.table("groups")
    role_ids = set(user.get("roleIds", []))
    for gid in user.get("groupIds", []):
        group = groups.get(gid)
        if group:
            role_ids.update(group.get("roleIds", []))
    permissions: set[str] = set()
    privileged = False
    for rid in role_ids:
        role = roles.get(rid)
        if role is None:
            continue
        permissions.update(role.get("permissions", []))
        privileged = privileged or role.get("category") == "privileged"
    return {
        "userId": user["id"],
        "status": user["status"],
        "roleIds": sorted(role_ids),
        "groupIds": sorted(user.get("groupIds", [])),
        "permissions": sorted(permissions),
        "privileged": privileged,
        "mfaEnabled": user.get("mfaEnabled", False),
        "active": user["status"] == "active",
    }


@base.op(ID, "get_user")
def get_user(ctx: Ctx) -> dict:
    return _resolve_user(ctx)


@base.op(ID, "lookup_user")
def lookup_user(ctx: Ctx) -> dict:
    ctx.require("query")
    query = str(ctx.payload["query"]).lower()
    matches = [u for u in ctx.state.table("users").values()
               if query in u["displayName"].lower()
               or query in u["workEmail"].lower()
               or query in u["username"].lower()]
    return ctx.paginate(sorted(matches, key=lambda u: u["displayName"]), size_default=25)


@base.op(ID, "list_users")
def list_users(ctx: Ctx) -> dict:
    items = list(ctx.state.table("users").values())
    for field in ("departmentId", "teamId", "status", "employmentType"):
        value = ctx.get(field)
        if value:
            items = [u for u in items if u[field] == value]
    role = ctx.get("roleId")
    if role:
        items = [u for u in items if role in u.get("roleIds", [])]
    group = ctx.get("groupId")
    if group:
        items = [u for u in items if group in u.get("groupIds", [])]
    items.sort(key=lambda u: u["id"])
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_user_access")
def get_user_access(ctx: Ctx) -> dict:
    return _effective_access(ctx, _resolve_user(ctx))


@base.op(ID, "list_direct_reports")
def list_direct_reports(ctx: Ctx) -> dict:
    manager = _resolve_user(ctx, "managerId")
    reports = [u for u in ctx.state.table("users").values()
               if u.get("managerId") == manager["id"]]
    reports.sort(key=lambda u: u["displayName"])
    return {"managerId": manager["id"], "count": len(reports), "items": reports}


@base.op(ID, "get_manager_chain")
def get_manager_chain(ctx: Ctx) -> dict:
    user = _resolve_user(ctx)
    users = ctx.state.table("users")
    chain = []
    seen = {user["id"]}
    current = user.get("managerId")
    while current and current not in seen:
        manager = users.get(current)
        if manager is None:
            break
        seen.add(current)
        chain.append({"id": manager["id"], "displayName": manager["displayName"],
                      "jobTitle": manager["jobTitle"], "departmentId": manager["departmentId"]})
        current = manager.get("managerId")
    return {"userId": user["id"], "depth": len(chain), "chain": chain}


@base.op(ID, "list_roles")
def list_roles(ctx: Ctx) -> dict:
    items = list(ctx.state.table("roles").values())
    category = ctx.get("category")
    if category:
        items = [r for r in items if r["category"] == category]
    items.sort(key=lambda r: r["id"])
    return ctx.paginate(items, size_default=50)


@base.op(ID, "get_role")
def get_role(ctx: Ctx) -> dict:
    ctx.require("roleId")
    role = ctx.state.table("roles").get(ctx.payload["roleId"])
    if role is None:
        raise DomainError(404, "role_not_found", ctx.payload["roleId"])
    assigned = [u["id"] for u in ctx.state.table("users").values()
                if ctx.payload["roleId"] in u.get("roleIds", [])]
    return {**role, "assignedCount": len(assigned)}


@base.op(ID, "list_groups")
def list_groups(ctx: Ctx) -> dict:
    items = list(ctx.state.table("groups").values())
    group_type = ctx.get("type")
    if group_type:
        items = [g for g in items if g["type"] == group_type]
    items.sort(key=lambda g: g["id"])
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_group")
def get_group(ctx: Ctx) -> dict:
    ctx.require("groupId")
    group = ctx.state.table("groups").get(ctx.payload["groupId"])
    if group is None:
        raise DomainError(404, "group_not_found", ctx.payload["groupId"])
    return group


@base.op(ID, "list_teams")
def list_teams(ctx: Ctx) -> dict:
    items = list(ctx.state.table("teams").values())
    dept = ctx.get("departmentId")
    if dept:
        items = [t for t in items if t["departmentId"] == dept]
    items.sort(key=lambda t: t["id"])
    return ctx.paginate(items, size_default=50)


@base.op(ID, "get_team")
def get_team(ctx: Ctx) -> dict:
    ctx.require("teamId")
    team = ctx.state.table("teams").get(ctx.payload["teamId"])
    if team is None:
        raise DomainError(404, "team_not_found", ctx.payload["teamId"])
    members = [u["id"] for u in ctx.state.table("users").values()
               if u["teamId"] == team["id"]]
    return {**team, "memberIds": sorted(members)}


@base.op(ID, "list_departments")
def list_departments(ctx: Ctx) -> dict:
    items = list(ctx.state.table("departments").values())
    items.sort(key=lambda d: d["id"])
    return ctx.paginate(items, size_default=50)


@base.op(ID, "get_department")
def get_department(ctx: Ctx) -> dict:
    ctx.require("departmentId")
    departments = ctx.state.table("departments")
    dept = departments.get(ctx.payload["departmentId"])
    if dept is None:
        raise DomainError(404, "department_not_found", ctx.payload["departmentId"])
    subtree = {dept["id"]}
    changed = True
    while changed:
        changed = False
        for d in departments.values():
            if d["parentDepartmentId"] in subtree and d["id"] not in subtree:
                subtree.add(d["id"])
                changed = True
    child_ids = sorted(d["id"] for d in departments.values()
                       if d["parentDepartmentId"] == dept["id"])
    teams = [t["id"] for t in ctx.state.table("teams").values()
             if t["departmentId"] in subtree]
    return {**dept, "childDepartmentIds": child_ids, "teamIds": sorted(teams)}


@base.op(ID, "list_service_accounts")
def list_service_accounts(ctx: Ctx) -> dict:
    items = list(ctx.state.table("service_accounts").values())
    for field in ("ownerTeamId", "environment", "status"):
        value = ctx.get(field)
        if value:
            items = [s for s in items if s[field] == value]
    items.sort(key=lambda s: s["id"])
    return ctx.paginate(items, size_default=25)


@base.op(ID, "get_service_account")
def get_service_account(ctx: Ctx) -> dict:
    ctx.require("serviceAccountId")
    svc = ctx.state.table("service_accounts").get(ctx.payload["serviceAccountId"])
    if svc is None:
        raise DomainError(404, "service_account_not_found", ctx.payload["serviceAccountId"])
    return svc
