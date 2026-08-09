import { describe, expect, it } from 'vitest';
import { redactInternal, redactInternalAll } from './redact';

describe('redactInternal', () => {
  it('strips internal keys and keeps everything else', () => {
    const row = { id: 'c1', email: 'a@b.c', notes: 'AV rider outstanding' };
    const redacted = redactInternal(row);
    expect(redacted).toEqual({ id: 'c1', email: 'a@b.c' });
    expect(redacted && 'notes' in redacted).toBe(false);
  });

  it('does not mutate the input row', () => {
    const row = { id: 'c1', notes: 'secret' };
    redactInternal(row);
    expect(row.notes).toBe('secret');
  });

  it('is null- and undefined-safe', () => {
    expect(redactInternal(null)).toBeNull();
    expect(redactInternal(undefined)).toBeNull();
  });

  it('is a no-op on rows without internal keys', () => {
    expect(redactInternal({ id: 'x' })).toEqual({ id: 'x' });
  });
});

describe('redactInternalAll', () => {
  it('redacts every row and drops missing ones', () => {
    const rows = [{ id: '1', notes: 'a' }, null, { id: '2' }, undefined];
    expect(redactInternalAll(rows)).toEqual([{ id: '1' }, { id: '2' }]);
  });
});
