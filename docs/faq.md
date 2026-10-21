# FAQ

Short answers to the questions people ask most. If yours is not here, open a [question](https://github.com/itsmemac/AgentCairn/issues/new/choose).

- [Why not just resume the session?](#why-not-just-resume-the-session)
- [Why not run the agent on a VPS inside tmux?](#why-not-run-the-agent-on-a-vps-inside-tmux)
- [My machine died before the agent wrote a handoff. What does the next session get?](#my-machine-died-before-the-agent-wrote-a-handoff-what-does-the-next-session-get)
- [How is this different from CLAUDE.md or the agent's own memory files?](#how-is-this-different-from-claudemd-or-the-agents-own-memory-files)
- [How is it different from other memory tools or a code index?](#how-is-it-different-from-other-memory-tools-or-a-code-index)
- [How does the briefing decide what to include?](#how-does-the-briefing-decide-what-to-include)
- [Does it call an LLM? What does it cost?](#does-it-call-an-llm-what-does-it-cost)
- [What is a handoff, and what goes in it?](#what-is-a-handoff-and-what-goes-in-it)
- [What does it record from my sessions, and what about secrets?](#what-does-it-record-from-my-sessions-and-what-about-secrets)
- [How do backups, restores and encryption work?](#how-do-backups-restores-and-encryption-work)
- [Which agents does it work with?](#which-agents-does-it-work-with)
- [Do I need accounts and roles?](#do-i-need-accounts-and-roles)
- [Why can I not tell the graph colours apart?](#why-can-i-not-tell-the-graph-colours-apart)
- [A write failed with "Cannot supersede". What does it mean?](#a-write-failed-with-cannot-supersede-what-does-it-mean)

## Why not just resume the session?

If you work on one machine that survives, the agent's own resume covers most of it, and you do not need Cairn for that.

Those sessions are stored on that machine, under that account. Cairn is for the cases where that is not enough:

- the machine is lost or broken (the reason this project exists: a dead laptop took every chat and local memory file with it);
- you switch computers or accounts, or hand the work to someone else;
- the old transcript has grown too long to be useful, and you want what was learned without carrying the whole conversation.

A resumed chat brings back everything that was said. Cairn keeps the distilled parts (decisions and why they were made, gotchas, what was tried and dropped, a handoff for what is half done) on a server you own, and warns when the files a memory was written about have changed.

## Why not run the agent on a VPS inside tmux?

For one live session on one remote checkout, tmux on a VPS is a good answer and simpler than Cairn. The agent keeps running when your machine loses power, and you reattach from another. If that is how you work, keep it.

Cairn is for when it is not:

- each machine has its own checkout and its own agent, and you want to code locally with your own editor, tools and secrets;
- the knowledge should outlive one session: a tmux session holds one conversation, and after a compaction, a restart or a few weeks the reasons behind decisions are gone from it;
- several people or projects share it, with private projects and roles.

You can combine them: run the Cairn server on the same VPS and use tmux for the live session.

## My machine died before the agent wrote a handoff. What does the next session get?

The recorded session up to the cut, not only the last checkpoint. The hooks save a snapshot of the session when you send a prompt and when each turn ends (and before a compaction and at session end): what you asked, the agent's last message, the files it edited, commits, the branch and commit, and which files were uncommitted. The next session opens with that, and the start-up check warns you if the last commit was never pushed.

What it cannot recover:

- **Work in a turn that was still running.** The snapshot is taken at the prompt and at the end of a turn, so edits made in the middle of a turn are not recorded.
- **Uncommitted code.** It records the names of the uncommitted files, not their contents. If the machine dies, those changes are gone; the next session is told they existed and where.
- **The agent's reasoning.** A handoff (in progress, next, blocked) exists only if the agent wrote one.

So commit and push often, and let the agent write a handoff at natural stopping points.

This depends on the Claude Code hooks that `cairn init` installs. If hooks are disabled in your Claude Code settings, or `CAIRN_SESSION_CAPTURE=off`, nothing is captured. Run `cairn doctor` to check that the session capture hooks are installed.

## How is this different from CLAUDE.md or the agent's own memory files?

Those are files on one machine. Cairn's memory is shared across machines, accounts and people, structured by kind (decision, convention, gotcha and so on), searchable, and aware of the repository: each memory records the commit and files it was about, so the briefing flags it when they change. It also keeps history (a changed fact supersedes the old one instead of overwriting it) and records sessions and handoffs, which a plain file does not. CLAUDE.md is still the right place for instructions you want the agent to follow every time; Cairn adds a short block to it that tells the agent how to use the memory.

## How is it different from other memory tools or a code index?

They solve different problems, and you can use them together.

- A **code index** (a graph of the code's symbols and call chains) is derived from the code. It cannot say why something is the way it is, what was tried and dropped, or what is half finished. Cairn stores that.
- A **general-purpose agent memory system** aims at broad retrieval across anything an agent has seen. Cairn is narrower: memory scoped per project and written by the agent, plus the project workflow around it (handoff and resume, staleness flags, history kept, self-hosted with sharing and roles).

One honest limit: Cairn's recall is full-text search, not semantic search, and it has not been benchmarked against retrieval-focused systems.

## How does the briefing decide what to include?

Deterministically, with no model involved, and not by how often a memory was referenced (nothing tracks reference counts today).

The briefing opens with the latest handoff and the recent sessions. Then sections fill in a fixed priority: overview, conventions, gotchas, open threads, recent checkpoints, decisions, glossary. Each section gets a share of the token budget plus whatever earlier sections left unused. Inside a section, memories are ranked by importance (1 to 5, set by the agent) plus recency, minus a penalty if the files the memory was written about have changed since. A memory that does not fit is shortened once, then skipped. The budget defaults to 1200 tokens (`cairn briefing --tokens`, or `CAIRN_BRIEFING_TOKENS` for the hook).

## Does it call an LLM? What does it cost?

No. The server only stores, ranks and retrieves. The agent writes the memories, so there is no API key to manage and no per-token cost on the server. Running it costs whatever your Docker host and a Neo4j container cost.

## What is a handoff, and what goes in it?

A handoff is what the agent writes when it stops with work unfinished, so the next agent can carry on without being briefed again. It replaces the previous handoff for the same topic (the branch by default), and older ones are kept as history. It has:

- what is **done**, and what is **in progress** with its exact state;
- what to do **next**, in order;
- what is **blocked or open**;
- the **assumptions** being worked under: what is taken as given and is not obvious from the code;
- what the person asked that must keep being honoured;
- what was **tried and dropped**, and why;
- how to check the work, and where the repository stood.

## What does it record from my sessions, and what about secrets?

Per session: the first and latest things you asked (capped), the agent's last message, files edited, commits, branch and commit, uncommitted file names, and tool counts. It does not store the full transcript.

Common token shapes, stated passwords, `user:password@` in URLs and private keys are removed on your machine before anything is sent, and again on the server before storing. This is best effort, so there are three modes: `CAIRN_SESSION_CAPTURE=full` (the default), `meta` (no words are sent, only the file and commit facts) and `off` (nothing is sent). Prompts are kept to 800 characters and the reply to 3000.

## How do backups, restores and encryption work?

Everything lives in Neo4j, so backups are Neo4j backups. [Self-hosting](self-hosting.md#backups) shows a `neo4j-admin database dump`. Honest gaps: there are no versioned snapshots and no built-in restore test, so schedule your own dump and try restoring it now and then.

Memories are never edited in place: a changed fact creates a new memory that supersedes the old one, and the old one stays as history. That keeps concurrent writers from clobbering each other and means a mistaken change can be traced.

The data stays on your own box. Put TLS in front of the server with a reverse proxy ([Self-hosting](self-hosting.md#tls-and-reverse-proxies)). There is no end-to-end encrypted sync, because there is no third party in the loop.

## Which agents does it work with?

Any agent that speaks MCP can read and write memory. The hooks (briefing at session start, session capture, handoff reminder) are for Claude Code. The dashboard and the `cairn` CLI work with any of them.

## Do I need accounts and roles?

No. With one user the server is in solo mode: everything is yours and there is nothing to set up. Add a second user and projects become private to their owner, shared as viewer, editor or maintainer, with invite links, per-token scopes and an [audit log](access-control.md).

## Why can I not tell the graph colours apart?

Each memory kind has its own shape as well as its own colour, so the graph can be read without telling colours apart: octagon for handoff, star for overview, diamond for decision, rounded square for convention, triangle for gotcha, circle for checkpoint, tag for thread, pentagon for glossary, and hexagon for an area. The label pills in the side panel show the same shapes.

## A write failed with "Cannot supersede". What does it mean?

A memory you tried to replace (`supersedes`) is not an active memory of that project. The message names each id and says why: unknown, ambiguous (give more characters), or already replaced, and by which memory to use instead. Nothing is written when any id is wrong. The usual cause is retrying a write that already succeeded the first time; if so, there is nothing left to do.
