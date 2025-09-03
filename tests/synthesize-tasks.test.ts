import { beforeEach, afterEach, expect, test, vi } from 'vitest';

const SUPABASE_URL = 'https://example.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = 'service-key';
const TARGET_REPO = 'owner/repo';

beforeEach(() => {
  vi.resetModules();
  process.env.SUPABASE_URL = SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY;
  process.env.TARGET_REPO = TARGET_REPO;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.TARGET_REPO;
});

test('merges tasks and orders by date', async () => {
  vi.doMock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/lib/github.js', () => ({
    readFile: vi.fn().mockResolvedValue('vision'),
  }));
  vi.doMock('../src/lib/prompts.js', () => ({
    synthesizeTasksPrompt: vi.fn().mockResolvedValue(
`items:\n  - title: Newer\n    type: task\n    created: '2024-01-04'\n  - title: Old\n    type: task\n    created: '2024-01-03'\n  - title: Old\n    type: task\n    created: '2024-01-02'\n`),
  }));

  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: '1', type: 'task', title: 'Existing', priority: 5, created: '2024-01-05', source: 'codex' },
        { id: 'x', type: 'idea', title: 'Idea', created: '2024-01-01' },
        { id: 'y', type: 'done', content: 'finished' },
      ],
    } as any)
    .mockResolvedValueOnce({ ok: true } as any)
    .mockResolvedValueOnce({ ok: true } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { synthesizeTasks } = await import('../src/cmds/synthesize-tasks.ts');
  await synthesizeTasks();

  const upsertCall = fetchMock.mock.calls[1];
  const body = JSON.parse(upsertCall[1].body);
  const keys = ['title', 'type', 'content', 'priority', 'created_at', 'source'];
  expect(body).toEqual([
    {
      id: '1',
      title: 'Existing',
      type: 'task',
      content: null,
      priority: 1,
      created_at: new Date('2024-01-05').toISOString(),
      source: 'codex',
    },
    {
      title: 'Old',
      type: 'task',
      content: null,
      priority: 2,
      created_at: new Date('2024-01-03').toISOString(),
      source: null,
    },
    {
      title: 'Newer',
      type: 'task',
      content: null,
      priority: 3,
      created_at: new Date('2024-01-04').toISOString(),
      source: null,
    },
  ]);
  expect(body[0]).toHaveProperty('id');
  expect(body.slice(1).every(o => !('id' in o))).toBe(true);
  expect(body.every(o => keys.every(k => k in o))).toBe(true);
});

test('filters out extra properties from existing tasks', async () => {
  vi.doMock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/lib/github.js', () => ({
    readFile: vi.fn().mockResolvedValue('vision'),
  }));
  vi.doMock('../src/lib/prompts.js', () => ({
    synthesizeTasksPrompt: vi.fn().mockResolvedValue('items:\n  - title: New\n    type: task'),
  }));

  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: '1', type: 'task', title: 'Existing', created: '2024-01-05', priority: 5, source: 'codex', extra: 'x' },
      ],
    } as any)
    .mockResolvedValueOnce({ ok: true } as any)
    .mockResolvedValueOnce({ ok: true } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { synthesizeTasks } = await import('../src/cmds/synthesize-tasks.ts');
  await synthesizeTasks();

  const body = JSON.parse(fetchMock.mock.calls[1][1].body);
  const keys = ['id', 'title', 'type', 'content', 'priority', 'created_at', 'source'];
  expect(body[0]).toEqual({
    id: '1',
    title: 'Existing',
    type: 'task',
    content: null,
    priority: 1,
    created_at: new Date('2024-01-05').toISOString(),
    source: 'codex',
  });
  expect(Object.keys(body[0])).toEqual(keys);
});

test('skips Supabase update when no tasks generated even with existing tasks', async () => {
  vi.doMock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/lib/github.js', () => ({
    readFile: vi.fn().mockResolvedValue('vision'),
  }));
  vi.doMock('../src/lib/prompts.js', () => ({
    synthesizeTasksPrompt: vi.fn().mockResolvedValue('items: []'),
  }));

  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: '1', type: 'task', title: 'Existing', created: '2024-01-05' },
      ],
    } as any)
    .mockResolvedValueOnce({ ok: true } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { synthesizeTasks } = await import('../src/cmds/synthesize-tasks.ts');
  await synthesizeTasks();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.some(c => String(c[0]).includes('type=eq.task') && c[1]?.method === 'DELETE')).toBe(false);
  expect(fetchMock.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false);
});

test('does not delete tasks if upsert fails', async () => {
  vi.doMock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/lib/github.js', () => ({
    readFile: vi.fn().mockResolvedValue('vision'),
  }));
  vi.doMock('../src/lib/prompts.js', () => ({
    synthesizeTasksPrompt: vi.fn().mockResolvedValue('items:\n  - title: New\n    type: task'),
  }));

  const existing = { id: '1', type: 'task', title: 'Existing', created: '2024-01-05', priority: 5, source: 'codex' };

  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [existing],
    } as any)
    .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { synthesizeTasks } = await import('../src/cmds/synthesize-tasks.ts');
  await expect(synthesizeTasks()).rejects.toThrow();

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.some(c => c[1]?.method === 'DELETE')).toBe(false);
});

test('includes Supabase response text when upsert fails', async () => {
  vi.doMock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/lib/github.js', () => ({
    readFile: vi.fn().mockResolvedValue('vision'),
  }));
  vi.doMock('../src/lib/prompts.js', () => ({
    synthesizeTasksPrompt: vi.fn().mockResolvedValue('items:\n  - title: New\n    type: task'),
  }));

  const fetchMock = vi.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => [] } as any)
    .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'invalid row' } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { synthesizeTasks } = await import('../src/cmds/synthesize-tasks.ts');
  await expect(synthesizeTasks()).rejects.toThrow(/400.*invalid row/);
});

