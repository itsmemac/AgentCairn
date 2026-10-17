// Bumps the three packages to one version and keeps their internal dependencies in step.
// Usage: node scripts/release.mjs 0.2.0   (then commit, tag v0.2.0, push the tag)
import { readFileSync, writeFileSync } from 'node:fs'

const version = process.argv[2]
if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version ?? '')) {
  console.error('Usage: node scripts/release.mjs <major.minor.patch>')
  process.exit(1)
}

for (const dir of ['core', 'mcp-server', 'cli']) {
  const file = `packages/${dir}/package.json`
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  pkg.version = version
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (name.startsWith('@agentcairn/')) pkg.dependencies[name] = version
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`${pkg.name} -> ${version}`)
}
console.log(`\nNext: npm install --package-lock-only && git commit -am "Release ${version}" && git tag v${version} && git push --follow-tags`)
