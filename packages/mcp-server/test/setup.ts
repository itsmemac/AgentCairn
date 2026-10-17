import { resolve } from 'node:path'

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'))
} catch {
  // no .env: integration tests skip themselves
}
