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
      headers: new Headers(),
    } as any)
    .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers() } as any)
    .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers() } as any)
    .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers() } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { synthesizeTasks } = await import('../src/cmds/synthesize-tasks.ts');
  await synthesizeTasks();

  const updateBody = JSON.parse(fetchMock.mock.calls[1][1].body);
  const insertBody = JSON.parse(fetchMock.mock.calls[2][1].body);
  const keys = ['title', 'type', 'content', 'priority', 'created', 'source'];

  expect(updateBody).toEqual([
    {
      id: '1',
      title: 'Existing',
      type: 'task',
      content: null,
      priority: 1,
      created: new Date('2024-01-05').toISOString(),
      source: 'codex',
    },
  ]);
  expect(Object.keys(updateBody[0])).toEqual(['id', ...keys]);

  expect(insertBody).toEqual([
    {
      title: 'Old',
      type: 'task',
      content: null,
      priority: 2,
      created: new Date('2024-01-03').toISOString(),
      source: null,
    },
    {
      title: 'Newer',
      type: 'task',
      content: null,
      priority: 3,
      created: new Date('2024-01-04').toISOString(),
      source: null,
    },
  ]);
  const sortedKeys = (o: any) => Object.keys(o).sort();
  const insertKeys = sortedKeys(insertBody[0]);
  expect(insertBody.every(o => sortedKeys(o).join(',') === insertKeys.join(','))).toBe(true);
  expect(insertKeys).toEqual([...keys].sort());
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
      headers: new Headers(),
    } as any)
    .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers() } as any)
    .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers() } as any)
    .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers() } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { synthesizeTasks } = await import('../src/cmds/synthesize-tasks.ts');
  await synthesizeTasks();

  const body = JSON.parse(fetchMock.mock.calls[1][1].body);
  const keys = ['id', 'title', 'type', 'content', 'priority', 'created', 'source'];
  expect(body[0]).toEqual({
    id: '1',
    title: 'Existing',
    type: 'task',
    content: null,
    priority: 1,
    created: new Date('2024-01-05').toISOString(),
    source: 'codex',
  });
  expect(Object.keys(body[0])).toEqual(keys);
});

test('sets created null for invalid dates', async () => {
  vi.doMock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/lib/github.js', () => ({
    readFile: vi.fn().mockResolvedValue('vision'),
  }));
  vi.doMock('../src/lib/prompts.js', () => ({
    synthesizeTasksPrompt: vi.fn().mockResolvedValue(
      "items:\n  - title: New\n    type: task\n    created: 'not-a-date'"
    ),
  }));

  const fetchMock = vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [
        { id: '1', type: 'task', title: 'Existing', created: 'bad-date', source: 'codex' },
      ],
      headers: new Headers(),
    } as any)
    .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers() } as any)
    .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers() } as any)
    .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers() } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { synthesizeTasks } = await import('../src/cmds/synthesize-tasks.ts');
  await synthesizeTasks();

  const updateBody = JSON.parse(fetchMock.mock.calls[1][1].body);
  const insertBody = JSON.parse(fetchMock.mock.calls[2][1].body);

  expect(updateBody[0].created).toBeNull();
  expect(insertBody[0].created).toBeNull();
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
      headers: new Headers(),
    } as any)
    .mockResolvedValueOnce({ ok: true, status: 204, headers: new Headers() } as any);
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
      headers: new Headers(),
    } as any)
    .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error', headers: new Headers() } as any);
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
    .mockResolvedValueOnce({ ok: true, json: async () => [], headers: new Headers() } as any)
    .mockResolvedValueOnce({ ok: false, status: 400, text: async () => 'invalid row', headers: new Headers() } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { synthesizeTasks } = await import('../src/cmds/synthesize-tasks.ts');
  await expect(synthesizeTasks()).rejects.toThrow(/400.*invalid row/);
});

test('propagates sbRequest errors', async () => {
  vi.doMock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));
  vi.doMock('../src/lib/github.js', () => ({
    readFile: vi.fn().mockResolvedValue('vision'),
  }));
  vi.doMock('../src/lib/supabase.js', () => ({
    sbRequest: vi.fn().mockRejectedValue(new Error('sb failed')),
  }));

  const { synthesizeTasks } = await import('../src/cmds/synthesize-tasks.ts');
  await expect(synthesizeTasks()).rejects.toThrow('sb failed');
});

