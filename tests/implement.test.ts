import { beforeEach, afterEach, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  delete process.env.TARGET_REPO;
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('implementTopTask throws when TARGET_REPO missing', async () => {
  vi.mock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));
  const { implementTopTask } = await import('../src/cmds/implement.ts');
  await expect(implementTopTask()).rejects.toThrow('Missing env: TARGET_REPO');
});

