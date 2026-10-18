# Contributing to Agent Cairn

Thanks for helping! This guide covers how to get a working checkout, how the code is organised, and what a good pull request looks like.

## Getting set up

You need **Node 20.12 or newer**, **git**, and **Docker** (for a disposable Neo4j).

```bash
git clone https://github.com/itsmemac/agentcairn.git
cd agentcairn
npm install

# A throwaway Neo4j for the tests
docker run -d --name cairn-test-neo4j -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/change-me-please neo4j:5-community

cp .env.example .env
# in .env set:
#   NEO4J_URI=bolt://localhost:7687
#   NEO4J_PASSWORD=change-me-please

npm test
```

`npm test` builds every package and then runs all tests. `npm run typecheck` builds and type-checks without running tests.

> **Use a disposable Neo4j.** The integration tests run against a real database. They use random ids and delete what they create, and admin-account tests only run while the database has no admin, but you should still never point them at data you care about. The unit tests (project identity, file merging, briefing assembly, the UI import checks) need no database; integration tests skip themselves when `NEO4J_URI` is unset.

## Layout

| Path | What lives there |
| --- | --- |
| `packages/core` | Database layer: schema, memories, briefing, identity, accounts, graph queries |
| `packages/mcp-server` | MCP server, JSON API, auth, request recorder, dashboard (`ui/`) |
| `packages/cli` | The `cairn` command and Claude Code hooks |
| `docs/` | Guides |

Read [docs/architecture.md](docs/architecture.md) first; it explains the data model and why the server never touches the checkout.

## Conventions

- **TypeScript, strict, ESM.** Relative imports end in `.js` (NodeJS ESM resolution). Packages import each other through their built `dist/`, so `core` builds first; the root scripts list the order explicitly.
- **Tests hit a real Neo4j.** No database mocks: a mock once hid a PostGIS bug. Give test data a random prefix and clean it up in `afterAll`. Leave the database as you found it.
- **The server never calls an LLM.** Agents write the memories. Don't add model calls to the server.
- **Anything that needs the working tree belongs in `cli`**, not the server (see the architecture doc).
- **The dashboard has no build step.** Plain ES modules in `packages/mcp-server/ui`. Build DOM with the `h()`/`svg()` helpers; never assign `innerHTML` with data (the static icon set in `dom.js` is the one exception). The CSP forbids inline scripts. `ui.test.ts` enforces the import and safety rules.
- **Colors come from the tokens** in `ui/css/app.css` (a validated palette with dark and light variants). Don't introduce one-off hex values for data colors.
- **No secrets in the repository or in logs.** Never log or record `Authorization` headers.
- **Keep the schema migration-safe.** Changes to the graph shape need an idempotent migration in `core/src/schema.ts` and a test that builds the old shape and converts it.

## Making a change

1. Open an issue first for anything non-trivial, so we can agree on the approach.
2. Create a branch, make focused commits. Commit messages use the imperative mood and explain *why*; [Conventional Commits](https://www.conventionalcommits.org/) prefixes (`feat:`, `fix:`, `docs:`) are welcome.
3. Add or update tests. A bug fix should come with a test that fails without it.
4. Run `npm run typecheck` and `npm test`.
5. Update the docs if behaviour changes (`README.md`, `docs/`, `CHANGELOG.md`).
6. Open a pull request and fill in the template.

### Adding an MCP tool

Register it in `packages/mcp-server/src/tools.ts` with a zod input schema and a handler wrapped in `guard()` so errors reach the agent as messages instead of exceptions. Put database logic in `core`. Add a test in `packages/mcp-server/test/server.integration.test.ts` and list the tool in `docs/configuration.md` and the README.

### Adding an API endpoint

Machine endpoints (`/api/*`) live in `packages/mcp-server/src/http.ts`; dashboard endpoints (`/admin/api/*`) in `dashboard.ts`. Both are covered by integration tests in `packages/mcp-server/test/`.

### Working on the dashboard

The UI can be developed without a database: run the server against a throwaway Neo4j and a scratch admin account, or serve `packages/mcp-server/ui` with a stub of the `/admin/api` responses. After UI changes, check dark and light themes and a phone-width viewport.

## Reporting bugs and asking for features

Use the issue templates. For security problems, do **not** open a public issue: see [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).

## Releasing

Maintainers publish the three packages (`@agentcairn/core`, `@agentcairn/mcp-server`, `agentcairn`) to npm from CI using [trusted publishing](https://docs.npmjs.com/trusted-publishers): each package on npm lists the `publish.yml` workflow of this repository as a trusted publisher, so no npm token is stored anywhere.

```bash
node scripts/release.mjs 0.2.0                 # one version for all three packages
npm install --package-lock-only
git commit -am "Release 0.2.0"
git tag v0.2.0 && git push --follow-tags
```

The `Publish to npm` workflow checks that the tag matches the package versions, runs the full test suite, then publishes `core` first (with provenance). Versions that are already on npm are skipped, so a failed run can be re-run.
