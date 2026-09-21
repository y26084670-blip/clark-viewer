import { spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const startedAt = performance.now();
const root = fileURLToPath(new URL('../', import.meta.url));
const label = process.env.npm_lifecycle_event || 'build';

try {
  const result = spawnSync(process.execPath,
    ['node_modules/vite/bin/vite.js', 'build', ...process.argv.slice(2)],
    { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  process.exitCode = result.status ?? (result.signal ? 128 + (constants.signals[result.signal] || 1) : 1);
} finally {
  console.log(`Время сборки [${label}]: ${((performance.now() - startedAt) / 60000).toFixed(2)} мин.`);
}
