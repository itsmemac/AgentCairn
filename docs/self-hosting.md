# Self-hosting

Agent Cairn is two containers: the **server** (MCP endpoint, JSON API and dashboard) and **Neo4j**. The server image is published to GitHub Container Registry as `ghcr.io/itsmemac/agentcairn` for `linux/amd64` and `linux/arm64`.

```
Claude Code ──HTTP + token──► cairn (port 8787) ──bolt──► Neo4j (port 7687, private)
```

Only the server needs to be reachable by your agents. Neo4j should not be exposed.

## Requirements

- Docker with Compose v2
- About 300 MB of RAM for the server and 1 GB or more for Neo4j
- A Neo4j 5 Community (or newer) database, either the bundled one or your own

## Install with Docker Compose

```bash
git clone https://github.com/itsmemac/agentcairn.git
cd agentcairn
cp .env.example .env
```

Edit `.env` and set `NEO4J_PASSWORD` to something strong, then:

```bash
docker compose --profile with-neo4j up -d      # server + a bundled Neo4j
docker compose logs cairn                   # find the one-time setup code
```

To use a Neo4j you already run, set `NEO4J_URI` (and `NEO4J_USER`) in `.env` and start only the server:

```bash
docker compose up -d cairn
```

Inside a container, `localhost` is the container itself, so give the address the container can reach (the host's IP or DNS name).

The Neo4j data lives in the `neo4j-data` volume. Neo4j may take half a minute to accept connections on first start; the server retries and the dashboard's health indicator turns green when it is ready.

## First start: the admin account

While no admin exists the server prints a one-time code in its log:

```
┌────────────────────────────────────────────────────────────────────────┐
│  Agent Cairn: first-time setup                                            │
│                                                                        │
│  Open  http://<this-server>:8787/ui/  and enter this one-time code:    │
│                                                                        │
│          K7QM-XP29-WDAB                                                │
└────────────────────────────────────────────────────────────────────────┘
```

Open `http://<server>:8787/ui/`, enter the code and choose a username and password (at least 10 characters). This first account is the **admin**, and it owns every project that already exists, so upgrading a server that was running before users existed keeps all its data. The code lives only in memory: it stops working as soon as the account exists, and restarting before that prints a new one.

> Use `http://`, not `https://`, unless you have put a TLS-terminating proxy in front. The server itself speaks plain HTTP, so pointing a browser at `https://` simply fails to connect.

**Locked out?** Start the container once with `CAIRN_RESET_ADMIN=1`. It removes the admin accounts and the tokens they created, and prints a fresh setup code. The projects they owned are adopted by the next admin you create, and other users are untouched. Unset the variable afterwards. Anyone who can set the container's environment can already do this, so it is not a new way in.

## Tokens and connecting agents

Agents authenticate with bearer tokens created in the dashboard (**Access → Create token**). Tokens are stored as hashes and shown once, and each acts as the user who created it. Create one per computer. See [Using it with Claude Code](claude-code.md) for the client side.

With no tokens at all, agents are refused with a message pointing at the dashboard. `CAIRN_TOKEN` is an optional static token for scripts and bootstrap (it acts as the first admin), and `CAIRN_NO_AUTH=1` disables authentication entirely (only on a network you fully trust).

## Inviting other people

Open **Users**, choose a role, optionally a username, a project limit and projects to share, and create the invitation. Copy the link and send it yourself (there is no email server to configure); it works once and expires after 7 days. The person opens it, chooses a password and is signed in. Behind a reverse proxy, the link uses the address you are browsing the dashboard from, so open the dashboard through your public address first. Everyone's work then stays private to them until they share it. Details: [Users, projects and access control](access-control.md).

## TLS and reverse proxies

Plain HTTP is fine on a trusted LAN. Before exposing the server to the internet, put it behind a reverse proxy that terminates TLS (or use a VPN), then set:

```
CAIRN_COOKIE_SECURE=1     # mark dashboard session cookies Secure
CAIRN_TRUST_PROXY=1       # believe X-Forwarded-For for client addresses
```

A minimal Caddy example:

```
brain.example.com {
    reverse_proxy cairn:8787
}
```

The dashboard streams events over Server-Sent Events at `/admin/api/stream`, so make sure your proxy does not buffer that response. (The server sends `X-Accel-Buffering: no` for nginx.)

## Upgrading

```bash
docker compose pull
docker compose up -d
```

On startup the server creates any new schema and converts older data in place, then keeps running; the migrations are idempotent. The upgrade that introduced users adds ownership to existing projects (the first admin owns them) and gives them names, without removing anything. Back up before upgrading anyway.

If you run two server versions against one database for a while, that is fine: changes to the schema only add things, and the older version keeps working.

## Backups

Everything lives in Neo4j. Stop Neo4j and copy the volume, or use `neo4j-admin database dump`:

```bash
docker compose stop neo4j
docker run --rm -v agentcairn_neo4j-data:/data -v "$PWD":/backup neo4j:5-community \
  neo4j-admin database dump neo4j --to-path=/backup
docker compose start neo4j
```

The volume name is prefixed with your Compose project name (the folder name by default); check it with `docker volume ls`.

## Health and monitoring

`GET /healthz` returns `{"status":"ok"}` when the server can reach Neo4j and `503` when it cannot. It needs no authentication and is what the image's `HEALTHCHECK` uses.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Nothing answers on port 8787 | The container is not running or is published on another port; check `docker compose ps` and the logs. |
| Browser cannot connect, curl over `http://` works | You used `https://`. |
| Dashboard says it cannot reach Neo4j | Wrong `NEO4J_URI` (remember `localhost` inside Docker), wrong password, or Neo4j still starting. |
| Agents get `401` "No access tokens exist yet" | Create a token in the dashboard. |
| Agents get `401` "Missing or invalid bearer token" | The token is revoked, mistyped, or the `Authorization` header is not reaching the server (proxy). |
| Lost the setup code | Restart the container; a new code is printed while no admin exists. |
| Forgot the admin password | Restart once with `CAIRN_RESET_ADMIN=1`. |
| Setup page says setup is complete | An admin already exists; sign in instead. |

See [Configuration](configuration.md) for every setting.
