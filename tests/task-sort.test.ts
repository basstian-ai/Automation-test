import { expect, test } from 'vitest';
import { compareTasks as compareRoadmapTasks } from '../src/cmds/normalize-roadmap.ts';
import { compareTasks as compareSynthTasks } from '../src/cmds/synthesize-tasks.ts';

const makeTasks = (createdA: any, createdB: any) => [
  { title: 'b', created: createdB },
  { title: 'a', created: createdA },
];

test('sort handles numeric created values', () => {
  const tasksA = makeTasks(1000, 2000);
  expect(() => tasksA.sort(compareRoadmapTasks)).not.toThrow();
  expect(tasksA.map(t => t.title)).toEqual(['a', 'b']);
  const tasksB = makeTasks(1000, 2000);
  expect(() => tasksB.sort(compareSynthTasks)).not.toThrow();
  expect(tasksB.map(t => t.title)).toEqual(['a', 'b']);
});

test('sort handles Date created values', () => {
  const d1 = new Date('2023-01-01');
  const d2 = new Date('2024-01-01');
  const tasksA = makeTasks(d1, d2);
  expect(() => tasksA.sort(compareRoadmapTasks)).not.toThrow();
  expect(tasksA.map(t => t.title)).toEqual(['a', 'b']);
  const tasksB = makeTasks(d1, d2);
  expect(() => tasksB.sort(compareSynthTasks)).not.toThrow();
  expect(tasksB.map(t => t.title)).toEqual(['a', 'b']);
});
