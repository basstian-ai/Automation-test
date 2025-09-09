import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { ENV } from '../src/lib/env';

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv('TARGET_REPO', '');
  ENV.TARGET_OWNER = '';
  ENV.TARGET_REPO = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  ENV.TARGET_OWNER = '';
  ENV.TARGET_REPO = '';
});

test('implementTopTask throws when TARGET_REPO missing', async () => {
  vi.stubEnv('TARGET_OWNER', 'o');
  ENV.TARGET_OWNER = 'o';
  vi.mock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));
  const { implementTopTask } = await import('../src/cmds/implement.ts');
  await expect(implementTopTask()).rejects.toThrow('Missing env: TARGET_REPO');
});

