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
  process.env.PAT_TOKEN = 't';
  vi.doMock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));
  const { implementTopTask } = await import('../src/cmds/implement.ts');
  await expect(implementTopTask()).rejects.toThrow('Missing required TARGET_OWNER and TARGET_REPO');
});

test('implementTopTask passes repoTree to implementPlan', async () => {
  process.env.TARGET_OWNER = 'o';
  process.env.TARGET_REPO = 'r';

  vi.doMock('node:child_process', () => ({
    execSync: vi.fn((cmd: string) => (cmd.includes('git ls-files') ? 'a\nb\n' : '')),
  }));

  vi.doMock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));

  const mockTask = { id: '1', title: 't', content: 'c', priority: 1 };
  vi.doMock('../src/lib/supabase.js', () => ({
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            or: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [mockTask], error: null }),
              }),
            }),
          }),
        }),
      }),
    },
  }));

  let captured: string[] | undefined;
  vi.doMock('../src/lib/prompts.js', () => ({
    implementPlan: vi.fn(async (input) => {
      captured = input.repoTree;
      return JSON.stringify({ operations: [] });
    }),
  }));

  vi.doMock('../src/lib/github.js', () => ({
    readFile: vi.fn().mockResolvedValue(''),
    commitMany: vi.fn().mockResolvedValue(undefined),
    resolveRepoPath: (p: string) => p,
    ensureBranch: vi.fn(),
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
  }));

  const { implementTopTask } = await import('../src/cmds/implement.ts');
  await implementTopTask();

  expect(captured).toBeDefined();
  expect(captured!.length).toBeGreaterThan(0);
});

test('implementTopTask caps repoTree length', async () => {
  process.env.TARGET_OWNER = 'o';
  process.env.TARGET_REPO = 'r';
  process.env.REPO_TREE_LIMIT = '2';

  vi.doMock('node:child_process', () => ({
    execSync: vi.fn((cmd: string) =>
      cmd.includes('git ls-files')
        ? Array.from({ length: 5 }, (_, i) => `f${i}`).join('\n')
        : ''
    ),
  }));

  vi.doMock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));

  const mockTask = { id: '1', title: 't', content: 'c', priority: 1 };
  vi.doMock('../src/lib/supabase.js', () => ({
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            or: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [mockTask], error: null }),
              }),
            }),
          }),
        }),
      }),
    },
  }));

  let captured: string[] | undefined;
  vi.doMock('../src/lib/prompts.js', () => ({
    implementPlan: vi.fn(async (input) => {
      captured = input.repoTree;
      return JSON.stringify({ operations: [] });
    }),
  }));

  vi.doMock('../src/lib/github.js', () => ({
    readFile: vi.fn().mockResolvedValue(''),
    commitMany: vi.fn().mockResolvedValue(undefined),
    resolveRepoPath: (p: string) => p,
    ensureBranch: vi.fn(),
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
  }));

  const { implementTopTask } = await import('../src/cmds/implement.ts');
  await implementTopTask();

  expect(captured).toEqual(['f0', 'f1']);
});

test('implementTopTask handles delete ops and logs unsupported actions', async () => {
  process.env.TARGET_OWNER = 'o';
  process.env.TARGET_REPO = 'r';

  vi.doMock('node:child_process', () => ({
    execSync: vi.fn(() => '')
  }));

  vi.doMock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));

  const mockTask = { id: '1', title: 't', content: 'c', priority: 1 };
  vi.doMock('../src/lib/supabase.js', () => ({
    supabase: {
      from: () => ({
        select: () => ({
          eq: () => ({
            or: () => ({
              order: () => ({
                limit: () => Promise.resolve({ data: [mockTask], error: null }),
              }),
            }),
          }),
        }),
      }),
    },
  }));

  vi.doMock('../src/lib/prompts.js', () => ({
    implementPlan: vi.fn(async () =>
      JSON.stringify({
        operations: [
          { action: 'delete', path: 'file.txt' },
          { action: 'move', path: 'other.txt' },
        ],
      })
    ),
  }));

  const commitSpy = vi.fn().mockResolvedValue(undefined);
  vi.doMock('../src/lib/github.js', () => ({
    readFile: vi.fn().mockResolvedValue(''),
    commitMany: commitSpy,
    resolveRepoPath: (p: string) => p,
    ensureBranch: vi.fn(),
    getDefaultBranch: vi.fn().mockResolvedValue('main'),
  }));

  vi.doMock('../src/lib/tasks.js', () => ({
    completeTask: vi.fn().mockResolvedValue(undefined),
  }));

  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const { implementTopTask } = await import('../src/cmds/implement.ts');
  await implementTopTask();

  expect(commitSpy).toHaveBeenCalledWith(
    [{ path: 'file.txt', sha: null, mode: '100644' }],
    expect.anything(),
    { branch: undefined }
  );
  expect(warn).toHaveBeenCalledWith(
    'Unsupported action move for path other.txt'
  );
});

