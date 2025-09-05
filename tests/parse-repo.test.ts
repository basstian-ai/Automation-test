import { expect, test } from 'vitest';
import { parseRepo } from '../src/lib/github';

test('parseRepo rejects missing slash', () => {
  expect(() => parseRepo('foo')).toThrow('Invalid TARGET_REPO: foo');
});

test('parseRepo rejects extra segments', () => {
  expect(() => parseRepo('a/b/c')).toThrow('Invalid TARGET_REPO: a/b/c');
});

test('parseRepo splits owner and repo', () => {
  expect(parseRepo('o/r')).toEqual({ owner: 'o', repo: 'r' });
});
