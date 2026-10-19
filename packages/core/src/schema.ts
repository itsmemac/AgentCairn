import type { Brain } from './db.js'

export const SCHEMA_VERSION = 5

// Plain Cypher on Neo4j Community: no APOC, no enterprise-only features.
export const SCHEMA_STATEMENTS = [
  'CREATE CONSTRAINT project_id IF NOT EXISTS FOR (p:Project) REQUIRE p.id IS UNIQUE',
  'CREATE CONSTRAINT remote_key IF NOT EXISTS FOR (r:Remote) REQUIRE r.key IS UNIQUE',
  'CREATE CONSTRAINT session_key IF NOT EXISTS FOR (s:Session) REQUIRE s.key IS UNIQUE',
  'CREATE INDEX session_project IF NOT EXISTS FOR (s:Session) ON (s.projectId)',
  'CREATE CONSTRAINT user_username IF NOT EXISTS FOR (u:User) REQUIRE u.username IS UNIQUE',
  'CREATE CONSTRAINT user_id IF NOT EXISTS FOR (u:User) REQUIRE u.id IS UNIQUE',
  'CREATE CONSTRAINT area_id IF NOT EXISTS FOR (a:Area) REQUIRE a.id IS UNIQUE',
  'CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE',
  'CREATE INDEX memory_project_kind IF NOT EXISTS FOR (m:Memory) ON (m.projectId, m.kind)',
  'CREATE FULLTEXT INDEX memory_text IF NOT EXISTS FOR (m:Memory) ON EACH [m.title, m.body]',
  'CREATE CONSTRAINT brainmeta_id IF NOT EXISTS FOR (m:BrainMeta) REQUIRE m.id IS UNIQUE',
  'CREATE CONSTRAINT admin_username IF NOT EXISTS FOR (a:Admin) REQUIRE a.username IS UNIQUE',
  'CREATE CONSTRAINT token_id IF NOT EXISTS FOR (t:ApiToken) REQUIRE t.id IS UNIQUE',
  'CREATE CONSTRAINT token_hash IF NOT EXISTS FOR (t:ApiToken) REQUIRE t.hash IS UNIQUE',
] as const

/**
 * Containment is a tree: Project -[HAS_AREA]-> Area -[HAS_MEMORY]-> Memory. Earlier versions
 * hung every memory straight off the project (and linked it to its area with ABOUT), which made
 * the graph flat. This converts that shape in place and is safe to run repeatedly.
 */
export async function migrateContainment(brain: Brain): Promise<boolean> {
  const check = await brain.run(
    `OPTIONAL MATCH ()-[about:ABOUT]->() WITH count(about) AS a
     OPTIONAL MATCH (:Project)-[direct:HAS_MEMORY]->(:Memory) WITH a, count(direct) AS d
     OPTIONAL MATCH (m:Memory) WHERE NOT (:Area)-[:HAS_MEMORY]->(m)
     WITH a, d, count(m) AS orphans
     RETURN a + d + orphans AS n`,
  )
  if (Number(check.records[0]?.get('n')) === 0) return false

  await brain.run('MATCH (m:Memory)-[r:ABOUT]->(a:Area) MERGE (a)-[:HAS_MEMORY]->(m) DELETE r')
  await brain.run(
    `MATCH (m:Memory) WHERE NOT (:Area)-[:HAS_MEMORY]->(m)
     MATCH (p:Project {id: m.projectId})
     MERGE (a:Area {id: p.id + ':general'}) ON CREATE SET a.projectId = p.id, a.name = 'general'
     MERGE (p)-[:HAS_AREA]->(a)
     MERGE (a)-[:HAS_MEMORY]->(m)`,
  )
  await brain.run('MATCH (:Project)-[r:HAS_MEMORY]->(:Memory) DELETE r')
  return true
}

/**
 * Users, ownership and per-project remote aliases (schema 4). Idempotent, and additive: the old
 * `:Admin` label stays on accounts so an older server image keeps working during an upgrade.
 *
 * 1. every `:Admin` also becomes a `:User` (role admin, active, with an id);
 * 2. every project gets a name (its id, for projects that predate names);
 * 3. every project without an owner is owned by the first admin;
 * 4. every git remote becomes an alias of one project (`key`), instead of one node per hash.
 */
export async function migrateUsers(brain: Brain): Promise<boolean> {
  let changed = false
  const ran = async (query: string) => {
    const r = await brain.run(query)
    if (Number(r.records[0]?.get('n') ?? 0) > 0) changed = true
  }

  await ran(
    `MATCH (a:Admin) WHERE NOT a:User OR a.id IS NULL OR a.role IS NULL
     SET a:User, a.id = coalesce(a.id, randomUUID()), a.role = coalesce(a.role, 'admin'), a.status = coalesce(a.status, 'active')
     RETURN count(a) AS n`,
  )
  await ran('MATCH (p:Project) WHERE p.name IS NULL SET p.name = p.id RETURN count(p) AS n')
  await ran(
    `MATCH (u:User {role: 'admin'}) WITH u ORDER BY u.createdAt LIMIT 1
     MATCH (p:Project) WHERE NOT (:User)-[:MEMBER_OF {role: 'owner'}]->(p)
     MERGE (u)-[m:MEMBER_OF]->(p) ON CREATE SET m.since = datetime()
     SET m.role = 'owner'
     RETURN count(p) AS n`,
  )
  await ran(
    `MATCH (r:Remote)-[:BELONGS_TO]->(p:Project) WHERE r.key IS NULL
     SET r.key = p.id + ':' + r.hash
     RETURN count(r) AS n`,
  )
  return changed
}

/**
 * Keeps the bookkeeping nodes from looking like stray data: the first-setup lock is removed once
 * an admin exists, and each access token is linked to the admin who created it.
 */
export async function tidySystemNodes(brain: Brain): Promise<void> {
  await brain.run("MATCH (l:BrainMeta {id: 'setup'}) WHERE EXISTS { MATCH (a) WHERE a:User OR a:Admin } DELETE l")
  await brain.run(
    `MATCH (t:ApiToken) WHERE t.createdBy IS NOT NULL AND NOT ()-[:CREATED]->(t)
     MATCH (a) WHERE (a:User OR a:Admin) AND a.username = toLower(t.createdBy)
     MERGE (a)-[:CREATED]->(t)`,
  )
}

export async function ensureSchema(brain: Brain): Promise<void> {
  // The old one-remote-per-hash constraint would reject per-project aliases. Do not add an index on
  // Remote.hash in its place: an older server image creates that constraint again at startup, and it
  // cannot while an index on the same property exists (it would fail every request).
  await brain.run('DROP CONSTRAINT remote_hash IF EXISTS')
  for (const statement of SCHEMA_STATEMENTS) {
    await brain.run(statement)
  }
  await migrateContainment(brain)
  await migrateUsers(brain)
  await tidySystemNodes(brain)
  await brain.run(
    `MERGE (m:BrainMeta {id: 'schema'})
     ON CREATE SET m.version = $version, m.createdAt = datetime()
     SET m.version = CASE WHEN m.version < $version THEN $version ELSE m.version END`,
    { version: SCHEMA_VERSION },
  )
}

export async function schemaVersion(brain: Brain): Promise<number | null> {
  const result = await brain.run(`MATCH (m:BrainMeta {id: 'schema'}) RETURN m.version AS v`)
  const v = result.records[0]?.get('v')
  return v === undefined || v === null ? null : Number(v)
}
