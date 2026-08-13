/**
 * Eval defects #5/#16: the speaker Status field renders through RecordForm's
 * enum select, whose options now take display labels from `enumNames`
 * (index-aligned with `enum`) — organiser-written custom status labels can't
 * be reconstructed from the key. Missing entries fall back to
 * toReadableText(key), the previous behavior.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/preact';
import { RecordForm } from './RecordForm';

const schema = {
  type: 'object',
  properties: {
    speaker_status: {
      type: 'string',
      title: 'Status',
      enum: ['awaiting_reply', 'confirmed', 'keynote_hold'],
      enumNames: ['Awaiting reply', 'Confirmed'],
    },
  },
};

describe('RecordForm enumNames', () => {
  it('labels enum options from enumNames, falling back to readable keys', () => {
    render(
      <RecordForm
        schema={schema}
        initialValues={{ speaker_status: 'confirmed' }}
        onSubmit={vi.fn().mockResolvedValue(true)}
        onCancel={() => {}}
        title="Edit speaker"
      />,
    );
    const select = screen.getByLabelText('Status') as HTMLSelectElement;
    const labels = Array.from(select.options).map((o) => o.textContent);
    expect(labels).toContain('Awaiting reply');
    expect(labels).toContain('Confirmed');
    // No enumNames entry for the third key: it still renders, labelled by the
    // toReadableText fallback (which capitalizes but keeps underscores).
    const third = Array.from(select.options).find((o) => o.value === 'keynote_hold');
    expect(third).toBeTruthy();
    expect(third!.textContent).toBe('Keynote_hold');
    expect(select.value).toBe('confirmed');
  });
});
