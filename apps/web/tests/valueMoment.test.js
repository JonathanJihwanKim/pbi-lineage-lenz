/**
 * The estimate behind the one place this app asks for anything.
 *
 * The claim it makes is about the user's own work, so it has to be conservative. Saying
 * "this saved you 45 minutes" to somebody who would have spent five is the kind of small
 * dishonesty that costs more trust than the ask could ever be worth — particularly in a
 * tool whose entire pitch is that it does not guess.
 */

import { describe, it, expect } from 'vitest';
import { estimateByHand, describeElapsed } from '../src/valueMoment.js';

const model = (columns, measures) => ({
  columns: Array.from({ length: columns }),
  measures: Array.from({ length: measures }),
});

describe('estimateByHand', () => {
  it('says nothing about a model too small to claim anything about', () => {
    expect(estimateByHand(model(10, 3))).toBeNull();
    expect(estimateByHand(model(0, 0))).toBeNull();
  });

  it('gives a range in minutes for a modest model', () => {
    expect(estimateByHand(model(100, 20))).toMatch(/^\d+–\d+ minutes$/);
  });

  it('gives a range in hours for a larger one', () => {
    expect(estimateByHand(model(300, 100))).toMatch(/^\d+–\d+ hours$/);
  });

  it('stops counting rather than claiming a precise number of days', () => {
    // 473 columns and 274 measures is a real model. "the better part of a day" is
    // defensible; "6.4 hours" would be invented precision.
    expect(estimateByHand(model(473, 274))).toBe('the better part of a day');
  });

  it('never returns a range that reads as exact', () => {
    for (const [columns, measures] of [[100, 20], [200, 60], [400, 200]]) {
      const estimate = estimateByHand(model(columns, measures));
      expect(estimate).not.toMatch(/\.\d/);
    }
  });

  it('tolerates a model with no arrays at all', () => {
    expect(estimateByHand({})).toBeNull();
  });
});

describe('describeElapsed', () => {
  it('does not render a fast export as a broken timer', () => {
    // `(40 / 1000).toFixed(1)` is "0.0", and "Done in 0.0s" reads as a bug rather than
    // as speed — the opposite of what the sentence exists to say.
    expect(describeElapsed(40)).toBe('Done in under a second.');
    expect(describeElapsed(0)).toBe('Done in under a second.');
  });

  it('reports a real duration once there is one', () => {
    expect(describeElapsed(5900)).toBe('Done in 5.9s.');
  });

  it('does not produce nonsense from a missing measurement', () => {
    expect(describeElapsed(undefined)).toBe('Done in under a second.');
    expect(describeElapsed(NaN)).toBe('Done in under a second.');
  });
});
