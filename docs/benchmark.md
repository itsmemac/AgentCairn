# Benchmark: what a session costs with and without Agent Cairn

This page measures one thing: how many tokens an agent loads to get oriented in a project, and whether the facts that matter are still reachable. It does not measure how well an agent completes tasks, and the limits are listed at the end. Everything here can be reproduced with a script in this repository.

## The numbers

Measured on two real projects with `scripts/benchmark.mjs` (Agent Cairn itself, 61 memories, and a C# desktop app, 11 memories). Tokens are estimated as characters divided by 4 on both sides, so the counts are approximate and the ratios are the useful part.

| What the agent loads at the start | Agent Cairn project | C# desktop app |
| --- | ---: | ---: |
| Read the docs (README, docs/, CLAUDE.md, manifests) | 21,942 tokens | 9,351 tokens |
| Read the docs and all the source | 212,516 tokens | 599,139 tokens |
| **Cairn briefing** (default budget, 1,200 tokens) | **1,165 tokens** | **1,151 tokens** |
| Cairn resume (the full handoff and recent sessions, unbudgeted) | 3,715 tokens | 1,093 tokens |

So the briefing is about 19x smaller than the docs and about 180x smaller than the whole project on the first, and 8x and 520x on the second. The briefing has a fixed budget, so it stays near 1.2k tokens however large the project grows; the cost of reading the project grows with it.

A real agent does not read everything. Its cost is somewhere between the first two rows, and it pays it again at the start of every session that has no memory. The briefing replaces that orientation. It does not replace reading the code a task needs.

## Is the answer still there?

Fewer tokens only helps if the facts survive. For the Agent Cairn project, 12 non-obvious facts were checked, such as why the Docker build must not run npm under QEMU, which schema change broke the previous server image, and what the owner decided about commit trailers (`benchmarks/facts-agentcairn.json`). For each, the script checks whether it can be found in the docs, in the source, in the 1,200-token briefing, and in a single recall query (the top 5 results).

| Where the fact can be found | Facts found (of 12) |
| --- | ---: |
| In the docs | 4 |
| Somewhere in the source (comments, tests, config) | 10 |
| In the briefing | 3 |
| In one recall query, about 980 tokens | 12 |

How to read it:

- **The briefing is a map, not the whole memory.** It holds the most important memories, so it shows 3 of the 12. The rest are one targeted `cairn_recall` away, at roughly 1,000 tokens per query.
- **"In the source" means the text exists somewhere in about 212,000 tokens.** An agent would have to search and read to find it, and a fact like an owner's rule about commits is in no file at all.
- Two facts (the QEMU build and the commit-trailer rule) are in neither the docs nor the code comments the script checks, so without a memory they are rediscovered the hard way, or not at all.

## What this does not show

- **Task success, speed and cost.** No live agents were run on tasks with and without Cairn. That experiment is the real test, and it is not done.
- **The recall number is an upper bound.** The 12 facts were taken from the memories, and the queries were written by someone who knew what they said. A fair test would use questions written by someone else.
- **Two projects, one author.** Both are the author's own, and the memories were written by agents working with the author.
- **Estimated tokens.** The count is characters divided by 4, not a model tokenizer.
- **A stale memory costs trust, not just tokens.** The briefing flags memories whose files changed or whose review date has passed, but a wrong memory that is not flagged is worse than no memory. See the [FAQ](faq.md).

## Reproduce it on your own project

Link the folder with `cairn init`, set `CAIRN_URL` and `CAIRN_TOKEN`, then:

```bash
node scripts/benchmark.mjs path/to/your/repo
```

To test findability, give it a JSON list of your own facts (see `benchmarks/facts-agentcairn.json` for the format: a question, a recall query, and a pattern that appears in the answer). Questions written by someone who did not write the memories make the result more honest.
