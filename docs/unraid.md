# Running Agent Cairn on Unraid

Agent Cairn runs well on a home server. The server container and Neo4j both run on the box, and your computers connect to the server over your network. This guide covers the Unraid-specific steps; the general ones are in [Self-hosting](self-hosting.md).

```
Claude Code ──HTTP + token──► cairn (Docker) ──bolt──► Neo4j (Docker)
                                   │
                             dashboard at /ui/
```

GitHub builds the image for you: every push to `main` publishes `ghcr.io/itsmemac/agentcairn:latest` (amd64 and arm64).

## 1. Make the image pullable

GitHub publishes it as a package. If the repository is private the package starts private too. Either:

- open the package on GitHub (**Packages → cairn → Package settings**) and set its visibility to **Public**, or
- on the server, log in once with a personal access token that has the `read:packages` scope:
  `docker login ghcr.io -u <github-user>`

## 2. Start it

### Option A: Docker tab with the template

1. Copy [`unraid-template.xml`](unraid-template.xml) to `/boot/config/plugins/dockerMan/templates-user/cairn.xml` on the server.
2. Docker tab → **Add Container** → choose the `cairn` template.
3. Set **Neo4j URI** and **Neo4j password**, then Apply.

The **Neo4j URI** is the address the container can reach, for example `bolt://<server-ip>:7687` for a Neo4j container published on the host. Inside a container `localhost` is the container itself.

The container gets a **WebUI** button that opens the dashboard.

### Option B: Compose

Use the **Docker Compose Manager** plugin, or run Compose from a terminal, with this repository's `docker-compose.yml`. See [Self-hosting](self-hosting.md#install-with-docker-compose).

No Neo4j yet? Use the Neo4j template from Community Applications, or the bundled one with `docker compose --profile with-neo4j up -d`.

## 3. Create the admin account

Find the one-time setup code under Docker tab → cairn → **Logs**, open `http://<server-ip>:8787/ui/`, enter it and create the account. Use `http://`, not `https://`.

## 4. Connect your computers

In the dashboard, **Access** → create a token, then copy the command the page generates:

```bash
claude mcp add cairn --scope user -e CAIRN_URL=http://<server-ip>:8787 -e CAIRN_TOKEN=<token> -- npx -y agentcairn mcp
```

See [Using it with Claude Code](claude-code.md) for hooks and the CLI.

## Notes

- Back up the Neo4j appdata folder (or use `neo4j-admin database dump`) as part of your normal Unraid backups.
- Before exposing the server beyond your LAN, put it behind a TLS reverse proxy or a VPN such as Tailscale. See [TLS and reverse proxies](self-hosting.md#tls-and-reverse-proxies).
- Change Neo4j's default password. The dashboard's **System** page warns while it is still the default.
