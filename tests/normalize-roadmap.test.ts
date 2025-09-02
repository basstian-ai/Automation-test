import { beforeEach, afterEach, expect, test, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn() }));
vi.mock('../src/lib/lock.js', () => ({ acquireLock: vi.fn(), releaseLock: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('sorts and deduplicates roadmap items', async () => {
  const rows = [
    { id: '1', type: 'task', title: 'Task A', priority: 2, created: '2023-02-01' },
    { id: '1', type: 'task', title: 'Task A duplicate', priority: 5, created: '2023-02-02' },
    { id: '2', type: 'task', title: 'Task B', priority: 1, created: '2023-01-03' },
    { id: '3', type: 'task', title: 'Task C', priority: 1, created: '2023-01-01' },
    { id: '4', type: 'task', title: 'Task D', priority: 1, created: '2023-01-01' },
  ];

  const selectIn = vi.fn().mockResolvedValue({ data: rows, error: null });
  const deleteIn = vi.fn().mockResolvedValue({ data: null, error: null });
  const deleteEq = vi.fn().mockResolvedValue({ data: null, error: null });
  const upsert = vi.fn().mockResolvedValue({ data: null, error: null });

  const from = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({ in: selectIn }),
    delete: vi.fn().mockReturnValue({ in: deleteIn, eq: deleteEq }),
    upsert,
  });

  const { createClient } = await import('@supabase/supabase-js');
  (createClient as any).mockReturnValue({ from });

  const lock = await import('../src/lib/lock.js');
  (lock.acquireLock as any).mockResolvedValue(true);
  (lock.releaseLock as any).mockResolvedValue(undefined);

  const { normalizeRoadmap } = await import('../src/cmds/normalize-roadmap.ts');
  await normalizeRoadmap();

  expect(selectIn).toHaveBeenCalledWith('type', ['task', 'new']);
  expect(deleteIn).toHaveBeenCalledWith('id', ['1']);
  expect(upsert).toHaveBeenCalledWith([
    { id: '3', type: 'task', priority: 1 },
    { id: '4', type: 'task', priority: 2 },
    { id: '2', type: 'task', priority: 3 },
    { id: '1', type: 'task', priority: 4 },
  ], { onConflict: 'id' });
});

test('propagates Supabase write errors', async () => {
  const selectIn = vi.fn().mockResolvedValue({ data: [{ id: '1', type: 'task', title: 'T' }], error: null });
  const deleteFn = vi.fn().mockResolvedValue({ data: null, error: null });
  const upsert = vi.fn().mockRejectedValue(new Error('boom'));

  const from = vi.fn().mockReturnValue({
    select: vi.fn().mockReturnValue({ in: selectIn }),
    delete: vi.fn().mockReturnValue({ in: deleteFn, eq: deleteFn }),
    upsert,
  });

  const { createClient } = await import('@supabase/supabase-js');
  (createClient as any).mockReturnValue({ from });

  const lock = await import('../src/lib/lock.js');
  const release = lock.releaseLock as any;
  (lock.acquireLock as any).mockResolvedValue(true);
  release.mockResolvedValue(undefined);

  const { normalizeRoadmap } = await import('../src/cmds/normalize-roadmap.ts');
  await expect(normalizeRoadmap()).rejects.toThrow('boom');
  expect(release).toHaveBeenCalled();
});

