import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../src/lib/supabase.js', () => ({
  supabase: { rpc: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
});

test('completeTask uses correct RPC parameters', async () => {
  const { supabase } = await import('../src/lib/supabase.js');
  (supabase.rpc as any).mockResolvedValue({ error: null });
  const { completeTask } = await import('../src/lib/tasks.ts');
  await completeTask({ id: '1', title: 'T', desc: 'D', priority: 2 });
  expect(supabase.rpc).toHaveBeenCalledWith('complete_task', {
    task_id: '1',
    title: 'T',
    description: 'D',
    priority: 2,
  });
});
