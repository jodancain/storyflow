import { test } from 'node:test';
import { execFileSync } from 'node:child_process';

test('complete source packaging preserves commit bytes and rejects private inputs', () => {
  execFileSync(process.env.PYTHON || 'python3', ['-m', 'unittest', 'discover', '-s', 'scripts/tests', '-p', 'test_package_source.py', '-v'], {
    // The suite creates isolated Git repositories and reads many blobs; a busy
    // development Mac can spend most of this time scheduling those subprocesses.
    cwd: process.cwd(), timeout: 120_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, stdio: 'pipe',
  });
});
