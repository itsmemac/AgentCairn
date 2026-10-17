# @agentcairn/core

The database layer of [Agent Cairn](https://github.com/itsmemac/agentcairn): shared project memory for AI coding agents, stored in Neo4j.

This package has no server and no UI. It provides:

- **Schema and migrations** (`ensureSchema`): constraints, indexes, and in-place conversion of older data shapes. Plain Cypher; works on Neo4j Community.
- **Memories**: `remember` (with atomic `supersedes`), `recall` (fulltext, scoped to a project), `getMemory`, `forgetMemory`, `listAreas`.
- **Briefings**: `buildBriefing` / `assembleBriefing` produce a token-budgeted summary of a project.
- **Staleness**: `checkStaleness` compares a memory's recorded commit and paths with a working tree.
- **Project identity**: git-remote normalization and hashing, `.cairn.json` links, `resolveProject`, `registerProject`.
- **Accounts and tokens**: first-admin creation, password verification (scrypt), hashed API tokens.
- **Explore queries** for the dashboard, and a read-only Cypher runner.

```ts
import { openBrain, loadConfig, ensureSchema, ensureProject, remember, buildBriefing } from '@agentcairn/core'

const brain = openBrain(loadConfig()) // NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD
await ensureSchema(brain)
await ensureProject(brain, 'my-project')
await remember(brain, 'my-project', { kind: 'gotcha', title: 'Cache keys include the version', body: 'Bumping it invalidates everything.', area: 'platform' })
console.log((await buildBriefing(brain, 'my-project')).text)
await brain.close()
```

See the [architecture notes](https://github.com/itsmemac/agentcairn/blob/main/docs/architecture.md) for the data model. MIT licensed.
