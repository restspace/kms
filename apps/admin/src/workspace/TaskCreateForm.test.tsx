/**
 * CNT-01: the New Task form had no assignee picker, so a manual task could
 * only ever create a definition row and the Tasks grid (which lists
 * assignments) stayed empty with no error. These cover the picker feeding
 * `assignee_contact_ids` through to the create call, and the guard that
 * stops a manual task from being saved with nobody on it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';

const queryResource = vi.fn();
const getTaskAudiences = vi.fn();
vi.mock('../api', () => ({
  queryResource: (resource: string) => (params: unknown) => queryResource(resource, params),
  getTaskAudiences: () => getTaskAudiences(),
}));
vi.mock('../components/dialogs', () => ({ appAlert: vi.fn(() => Promise.resolve()) }));

import { TaskCreateForm } from './TaskCreateForm';
import { appAlert } from '../components/dialogs';

const contact = (id: string, first: string, email: string) => ({
  id, event_id: 'ev', email, first_name: first, last_name: 'Speaker',
});

beforeEach(() => {
  queryResource.mockReset();
  getTaskAudiences.mockReset().mockResolvedValue({
    audiences: [
      { audience: 'speakers', count: 3 },
      { audience: 'accepted_speakers', count: 2 },
      { audience: 'roster', count: 5 },
      { audience: 'all_contacts', count: 6 },
    ],
  });
  vi.mocked(appAlert).mockClear();
});

describe('TaskCreateForm', () => {
  it('sends picked assignees with the create call', async () => {
    const user = userEvent.setup();
    queryResource.mockResolvedValue({ items: [contact('c1', 'Ada', 'ada@example.com')], total: 1 });
    const onSubmit = vi.fn().mockResolvedValue(true);

    render(<TaskCreateForm onSubmit={onSubmit} onCancel={() => {}} title="New task" />);

    await user.type(screen.getByLabelText(/^Title/), 'Send headshot');
    await user.type(screen.getByLabelText('Assignees'), 'ada');
    const option = await screen.findByRole('button', { name: /ada@example.com/i });
    await user.click(option);
    expect((await screen.findByTestId('task-picked-targets')).textContent).toContain('ada@example.com');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({
      title: 'Send headshot',
      target: 'contact',
      assignment_mode: 'manual',
      assignee_contact_ids: ['c1'],
    });
    expect(appAlert).not.toHaveBeenCalled();
  });

  it('refuses to save a manual task with no assignee', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<TaskCreateForm onSubmit={onSubmit} onCancel={() => {}} title="New task" />);

    await user.type(screen.getByLabelText(/^Title/), 'Nobody task');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Pick at least one assignee/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('explains that an automatic task has no assignments yet', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<TaskCreateForm onSubmit={onSubmit} onCancel={() => {}} title="New task" />);

    await user.type(screen.getByLabelText(/^Title/), 'Sign contract');
    await user.selectOptions(screen.getByLabelText('Assignment mode'), 'automatic');
    await user.selectOptions(screen.getByLabelText('Trigger'), 'on_accept');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ assignment_mode: 'automatic', assignee_contact_ids: [] });
    await waitFor(() => expect(appAlert).toHaveBeenCalled());
    expect(vi.mocked(appAlert).mock.calls[0][0]).toMatch(/assignments will be created/i);
  });

  it('sends an audience instead of ids when one is chosen (CNT-01)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<TaskCreateForm onSubmit={onSubmit} onCancel={() => {}} title="New task" />);

    await user.type(screen.getByLabelText(/^Title/), 'Upload slides');
    // Counts from the endpoint label the options honestly.
    const option = await screen.findByRole('option', { name: /Speakers \(anyone attached to a submission\) — 3/ });
    await user.selectOptions(screen.getByLabelText('Assign to'), option);
    // The one-at-a-time picker disappears — the audience is the target.
    expect(screen.queryByLabelText('Assignees')).toBeNull();
    expect(screen.getByText(/3 people will be assigned/i)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0][0] as Record<string, unknown>;
    expect(body).toMatchObject({ audience: 'speakers', target: 'contact' });
    expect(body.assignee_contact_ids).toBeUndefined();
  });

  it('blocks a manual task aimed at an empty audience', async () => {
    const user = userEvent.setup();
    getTaskAudiences.mockResolvedValue({ audiences: [{ audience: 'accepted_speakers', count: 0 }] });
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<TaskCreateForm onSubmit={onSubmit} onCancel={() => {}} title="New task" />);

    await user.type(screen.getByLabelText(/^Title/), 'Empty audience task');
    await waitFor(() => expect(getTaskAudiences).toHaveBeenCalled());
    await user.selectOptions(screen.getByLabelText('Assign to'), 'accepted_speakers');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/nobody in it yet/i);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('searches submissions once the target switches', async () => {
    const user = userEvent.setup();
    queryResource.mockResolvedValue({
      items: [{ id: 's1', code: 'SESS-4', title: 'A talk' }],
      total: 1,
    });
    const onSubmit = vi.fn().mockResolvedValue(true);
    render(<TaskCreateForm onSubmit={onSubmit} onCancel={() => {}} title="New task" />);

    await user.type(screen.getByLabelText(/^Title/), 'Upload slides');
    await user.selectOptions(screen.getByLabelText('Target'), 'submission');
    await user.type(screen.getByLabelText('Submissions'), 'talk');
    await user.click(await screen.findByRole('button', { name: /SESS-4/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(queryResource.mock.calls[queryResource.mock.calls.length - 1]?.[0]).toBe('submissions');
    expect(onSubmit.mock.calls[0][0]).toMatchObject({ target: 'submission', submission_ids: ['s1'] });
  });

  it('offers no group target — no groups tables exist', () => {
    render(<TaskCreateForm onSubmit={vi.fn()} onCancel={() => {}} title="New task" />);
    const options = Array.from(
      (screen.getByLabelText('Target') as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).toEqual(['contact', 'submission']);
  });
});
