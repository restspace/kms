/**
 * Eval defect (no duplicate detection): the generic create form's advisory
 * `formWarning` — shown when the check returns a message, cleared when it
 * returns null, and never a blocker (the submit button stays enabled).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import { RecordForm } from './RecordForm';

const schema = {
  type: 'object',
  properties: {
    first_name: { type: 'string', title: 'First name' },
    last_name: { type: 'string', title: 'Last name' },
  },
};

describe('RecordForm formWarning', () => {
  it('shows the advisory message without disabling save', async () => {
    const formWarning = vi.fn().mockResolvedValue('A contact named “Priya Raman” already exists in your events.');
    render(
      <RecordForm
        schema={schema}
        initialValues={{ first_name: 'Priya', last_name: 'Raman' }}
        onSubmit={vi.fn().mockResolvedValue(true)}
        onCancel={() => {}}
        title="New speaker"
        formWarning={formWarning}
      />,
    );
    const status = await screen.findByRole('status', undefined, { timeout: 2000 });
    expect(status.textContent).toContain('already exists');
    expect(formWarning).toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Create' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('renders no warning when the check returns null', async () => {
    const formWarning = vi.fn().mockResolvedValue(null);
    render(
      <RecordForm
        schema={schema}
        initialValues={{ first_name: 'Nia' }}
        onSubmit={vi.fn().mockResolvedValue(true)}
        onCancel={() => {}}
        title="New speaker"
        formWarning={formWarning}
      />,
    );
    await waitFor(() => expect(formWarning).toHaveBeenCalled(), { timeout: 2000 });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
