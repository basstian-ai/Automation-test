import { expect, test } from 'vitest';

test('withRepo injects owner/repo', async () => {
  const { withRepo } = await import('../src/lib/github.ts');
  const merged = withRepo({ owner: 'o', repo: 'r' }, { foo: 1 });
  expect(merged).toEqual({ owner: 'o', repo: 'r', foo: 1 });
});
