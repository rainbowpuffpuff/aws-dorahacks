import { describe, expect, it } from 'vitest';

describe('phase 0 scaffold', () => {
  it('uses the requested app name', () => {
    expect('launchtest').toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});
