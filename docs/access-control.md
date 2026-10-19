# Users, projects and access control

Agent Cairn has users, private projects and per-project roles. This page describes the model and says what is built and what is next.

## Principles

- **Private by default.** A project belongs to the user who made it. Nobody else can see that it exists until it is shared.
- **Share with a role.** An owner (or maintainer) adds another user to a project with a role. Access is always an explicit membership.
- **One authorization function.** Every MCP tool, API call and dashboard route asks `authorize(principal, action, project)`. The default is deny.
- **Least privilege for agents.** A token belongs to a user and can never do more than that user can.
- **Solo mode stays simple.** With a single user, nothing changes: no roles to think about, everything is theirs. Adding a second user switches the multi-user behaviour on.

## Concepts

| Thing | What it is |
| --- | --- |
| **User** | A person with a login. Instance role `admin` or `member`. |
| **Project** | Has a generated, unique **id** (`prj_…`) and a **name**. Two projects may share a name; the id is what identifies it. Projects created before this change keep their old id and use it as their name. |
| **Membership** | `(User)-[:MEMBER_OF {role}]->(Project)`. Exactly one `owner` per project. |
| **Token** | Created by a user, hashed at rest, shown once. Acts as that user. |

### Project roles

| Role | memory.read | memory.write | memory.delete | project.update | member.manage | project.delete |
| --- | :-: | :-: | :-: | :-: | :-: | :-: |
| viewer | ✓ | | | | | |
| editor | ✓ | ✓ | | | | |
| maintainer | ✓ | ✓ | ✓ | ✓ | ✓ (not owners) | |
| owner | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

### Instance roles

- **admin** invites, disables and removes users, resets passwords and sets limits. An admin does **not** get access to other people's projects by being an admin. Reading a private project is an explicit, audited break-glass action (the Cypher console, which is admin-only).
- **member** can create projects and be added to others.

A project that someone else shares with you is visible to you with your role, and nothing else of theirs is.

## How a request is resolved

1. The bearer token identifies a **user** (the token's creator). The old shared `CAIRN_TOKEN` environment token acts as the first admin.
2. The project comes from the folder: an explicit id or name in `.cairn.json`, else the git remote.
   - An **id** (`prj_…`, or a legacy id) matches exactly.
   - A **name** matches among the projects the user can access. If two match, the request fails and asks for the id.
   - A **git remote** matches an alias on a project the user can access. Aliases belong to a project, so two users who both work in the same repository each get their own project unless one shares theirs.
   - Nothing matches on a write: a new project is created, owned by the user, named after the repository.
3. `authorize` checks the user's role on that project against the action. No membership answers "not found", never "forbidden", so a private project's existence does not leak. A member with too little access gets "forbidden".

## Invitations (next phase)

An admin creates an invite for a username and instance role. It is a single-use link with 256 bits of randomness, stored hashed, expiring after 7 days. The invited person opens it and chooses a password. No email server is needed. SMTP can be added later.

## Data model

```
(:User {id, username, passwordHash, role, status, createdAt})
(:User)-[:MEMBER_OF {role, since}]->(:Project {id, name, createdAt})
(:User)-[:CREATED]->(:ApiToken)
(:Remote {key, hash})-[:BELONGS_TO]->(:Project)       key = projectId + ":" + hash
```

Existing `:Admin` accounts are relabelled to also be `:User` (role `admin`). The `:Admin` label stays for now so an older server image keeps working during an upgrade.

## Migration (automatic, idempotent)

1. Every `:Admin` becomes a `:User` with role `admin`.
2. Every project without a name gets `name = id`.
3. Every project without an owner is owned by the first admin.
4. Every remote becomes per-project (`key`).
5. The old shared environment token maps to the first admin.

## Recovery

If the only admin login is lost, start the server once with `CAIRN_RESET_ADMIN=1`. It removes the admin accounts and the tokens they created and prints a new setup code. The projects they owned have no owner until the next admin is created, who then owns them. Members and their projects are not touched.

## Upgrading

Everything the migration does is additive, so an older server image keeps working against a migrated database. The first admin owns all existing projects. Nothing about a single-user setup changes.

## Rollout

1. **Foundation (built):** users, memberships, generated project ids, per-project remote aliases, `authorize`, the migration, enforcement for MCP tools, the agent API and the dashboard (projects, memories, graph, tokens), a members API, admin-only Live/Query/System pages, and tests for every role against every action. There is no screen yet for adding users or sharing: that is the next two phases.
2. **Users:** invitations, the accept page, disabling users, password resets, a Users page for admins.
3. **Sharing:** a Members panel on each project, role changes, leaving, transferring ownership.
4. **Token scoping:** read-only tokens and tokens limited to chosen projects.
5. **Hardening and extras:** audit log page, teams (share with a group), OIDC single sign-on, TOTP.
