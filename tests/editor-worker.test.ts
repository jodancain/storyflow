import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('isolated editor queue, recovery, idempotency and scoped tool contract', () => {
  execFileSync(process.env.PYTHON || 'python3', ['-m', 'unittest', 'discover', '-s', 'ops/editor/tests', '-v'], {
    cwd: process.cwd(), timeout: 30_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe',
  });
});
