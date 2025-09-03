import { beforeEach, afterEach, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('insertRoadmap and upsertRoadmap forward items as-is', async () => {
  const select = vi.fn().mockResolvedValue({ data: [], error: null });
  const insert = vi.fn().mockReturnValue({ select });
  const upsert = vi.fn().mockReturnValue({ select });
    const from = vi.fn().mockReturnValue({ insert, upsert });
    vi.doMock('../src/lib/supabase.js', () => ({ supabase: { from } }));

  const { insertRoadmap, upsertRoadmap } = await import('../src/lib/roadmap.ts');
  await insertRoadmap([{ id: '1', type: 'bug', title: 't', content: 'c', created: 'now' }]);
  expect(insert).toHaveBeenCalledWith([
    { id: '1', type: 'bug', title: 't', content: 'c', created: 'now' },
  ]);
  await upsertRoadmap([{ id: '2', type: 'idea', title: 'i', content: 'c', created: 'now' }]);
  expect(upsert).toHaveBeenCalledWith([
    { id: '2', type: 'idea', title: 'i', content: 'c', created: 'now' },
  ], { onConflict: 'id' });
});
