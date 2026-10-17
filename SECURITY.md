# Security policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue.

Use GitHub's private reporting: on the repository's **Security** tab choose **Report a vulnerability**. Include what you found, how to reproduce it, and the version or commit. You will get an acknowledgement, and we will keep you updated while a fix is prepared. Please allow reasonable time to fix a problem before disclosing it publicly.

## Supported versions

Agent Cairn is at an early stage (0.x). Only the latest release and the `main` branch receive security fixes.

## What is in scope

- Authentication and authorization bypasses (agent tokens, dashboard sessions, the one-time setup code)
- Injection into Cypher or the read-only console's restrictions
- Leaking secrets, tokens or request data to users who should not see them
- Cross-site attacks against the dashboard (CSRF, XSS, clickjacking)
- Exposure of data across the isolation that does exist (dashboard versus agent endpoints, for example). Note that tokens are currently server-wide, not per project; see below.

## Security properties worth knowing

- Tokens are stored as SHA-256 hashes and shown once. Passwords are stored with scrypt.
- Dashboard sessions are in memory; restarting the server signs everyone out.
- The Live page's request recorder keeps payloads in memory only (`CAIRN_CAPTURE=meta` keeps summaries only). `Authorization` headers are never recorded.
- The Cypher console runs statements in a read transaction and screens for write keywords.
- Git remotes are stored as hashes, never as URLs.
- A token currently grants access to **all** projects on the server. Treat tokens as server-wide credentials. Per-project tokens are a possible future change.
- The server speaks plain HTTP. Put a TLS-terminating reverse proxy or a VPN in front of it before exposing it beyond a network you trust, and set `CAIRN_COOKIE_SECURE=1` and `CAIRN_TRUST_PROXY=1` when you do.
- Change Neo4j's default password and do not publish Neo4j's ports to untrusted networks.

## Hardening checklist for a deployment

- [ ] Strong, unique `NEO4J_PASSWORD`; Neo4j not reachable from outside the host or private network
- [ ] TLS in front of the server if it is reachable beyond your LAN
- [ ] One token per machine or tool, revoked when no longer needed
- [ ] `CAIRN_NO_AUTH` unset
- [ ] Container image pulled from a source you trust and kept up to date
