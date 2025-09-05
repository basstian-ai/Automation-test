import { beforeEach, afterEach, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  delete process.env.TARGET_OWNER;
  delete process.env.TARGET_REPO;
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.TARGET_OWNER;
  delete process.env.TARGET_REPO;
});

vi.mock('../src/lib/lock.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

test('implementTopTask throws when TARGET_OWNER missing', async () => {
  const { implementTopTask } = await import('../src/cmds/implement.ts');
  await expect(implementTopTask()).rejects.toThrow('Missing env: TARGET_OWNER');
});

test('implementTopTask throws when TARGET_REPO missing', async () => {
  process.env.TARGET_OWNER = 'o';
  const { implementTopTask } = await import('../src/cmds/implement.ts');
  await expect(implementTopTask()).rejects.toThrow('Missing env: TARGET_REPO');
});

