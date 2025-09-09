import { beforeEach, afterEach, expect, test, vi } from 'vitest';

const OLD_ENV = process.env;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...OLD_ENV };
  delete process.env.TARGET_OWNER;
  delete process.env.TARGET_REPO;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = OLD_ENV;
});

test('implementTopTask throws when TARGET_REPO missing', async () => {
  process.env.TARGET_OWNER = 'o';
  vi.mock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));
  const { implementTopTask } = await import('../src/cmds/implement.ts');
  await expect(implementTopTask()).rejects.toThrow('Missing required TARGET_OWNER and TARGET_REPO');
});

