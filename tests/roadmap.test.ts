import { beforeEach, afterEach, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  process.env.TARGET_REPO = 'owner/repo';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TARGET_REPO;
});

test('insertRoadmap and upsertRoadmap attach repo', async () => {
  const select = vi.fn().mockResolvedValue({ data: [], error: null });
  const insert = vi.fn().mockReturnValue({ select });
  const upsert = vi.fn().mockReturnValue({ select });
    const from = vi.fn().mockReturnValue({ insert, upsert });
    vi.doMock('../src/lib/supabase.js', () => ({ supabase: { from } }));

  const { insertRoadmap, upsertRoadmap } = await import('../src/lib/roadmap.ts');
  await insertRoadmap([{ id: '1', type: 'bug', title: 't', content: 'c', created: 'now' }]);
  expect(insert).toHaveBeenCalledWith([
    { id: '1', type: 'bug', title: 't', content: 'c', created: 'now', repo: 'owner/repo' },
  ]);
  await upsertRoadmap([{ id: '2', type: 'idea', title: 'i', content: 'c', created: 'now' }]);
  expect(upsert).toHaveBeenCalledWith([
    { id: '2', type: 'idea', title: 'i', content: 'c', created: 'now', repo: 'owner/repo' },
  ], { onConflict: 'id' });
});
