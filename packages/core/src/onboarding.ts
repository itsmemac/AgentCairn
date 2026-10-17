/**
 * What an agent receives when the brain knows nothing about a project yet.
 * The server never calls an LLM, so the agent does the exploring and writing.
 */
export function onboardingPrompt(projectId: string): string {
  return `# Brain briefing: ${projectId} (empty)

Agent Cairn has no memories for this project yet. You are the first one here, so build the memory now; every future session, on any machine, will start from it instead of re-reading the repo.

## Explore (keep it cheap)
1. README, CONTRIBUTING and docs index.
2. Manifests and config (package.json, pyproject.toml, Cargo.toml, go.mod, Makefile, CI files).
3. The top-level folder layout and the entry points. Do not read every file.

## Record with cairn_remember
- **overview** (one, importance 5): what the project is, the stack, the layout in a few lines, how to build, test and run.
- **convention**: how code is written and organized here (naming, error handling, testing style, branching).
- **gotcha**: traps and non-obvious behavior that cost time.
- **decision**: choices already made that are not obvious from the code, with the reason.
- Set \`area\` to the module or subsystem, and \`paths\` to the files the memory concerns so staleness can be detected later.

## Write memories that save tokens
- Capture the why and the non-obvious, not what the code already says.
- Short and specific: a few sentences each, no pasted code.
- One fact per memory, so a changed fact can be superseded alone (\`supersedes\`).

## From now on
Call cairn_checkpoint after finishing each goal, and cairn_remember when you learn a durable lesson.`
}
