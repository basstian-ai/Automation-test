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
    .mockResolvedValueOnce({ ok: true } as any)
    .mockResolvedValueOnce({ ok: true } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { synthesizeTasks } = await import('../src/cmds/synthesize-tasks.ts');
  await synthesizeTasks();

  const upsertCall = fetchMock.mock.calls[2];
  const body = JSON.parse(upsertCall[1].body);
  expect(body).toEqual([
    { id: '1', title: 'Existing', type: 'task', priority: 1, created_at: new Date('2024-01-05').toISOString(), source: 'codex' },
    { title: 'Old', type: 'task', priority: 2, created_at: new Date('2024-01-03').toISOString() },
    { title: 'Newer', type: 'task', priority: 3, created_at: new Date('2024-01-04').toISOString() },
  ]);
});

test('skips Supabase update when no tasks generated', async () => {
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
    .mockResolvedValueOnce({ ok: true, json: async () => [] } as any)
    .mockResolvedValueOnce({ ok: true } as any);
  vi.stubGlobal('fetch', fetchMock);

  const { synthesizeTasks } = await import('../src/cmds/synthesize-tasks.ts');
  await synthesizeTasks();

  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(fetchMock.mock.calls.some(c => String(c[0]).includes('type=eq.task') && c[1]?.method === 'DELETE')).toBe(false);
  expect(fetchMock.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false);
});

