import { describe, expect, it } from 'vitest';
import { distributeCols, playableCols } from './solver.pool';

describe('SolverPool — répartition', () => {
  it('playableCols : hauteur < 6', () => {
    expect(playableCols([])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(playableCols([0, 0, 0, 0, 0, 0, 1])).toEqual([1, 2, 3, 4, 5, 6]);
    const full = Array.from({ length: 6 }, () => 0);
    expect(playableCols(full)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('distributeCols : rond-robin équilibré', () => {
    expect(distributeCols(2, [0, 1, 2, 3, 4, 5, 6])).toEqual([
      [0, 2, 4, 6],
      [1, 3, 5],
    ]);
    expect(distributeCols(3, [0, 1, 2, 3, 4])).toEqual([
      [0, 3],
      [1, 4],
      [2],
    ]);
    expect(distributeCols(1, [0, 1, 2])).toEqual([[0, 1, 2]]);
    expect(distributeCols(4, [0])).toEqual([[0], [], [], []]);
  });
});