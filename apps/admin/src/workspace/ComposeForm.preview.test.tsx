/**
 * Workplan-14 F2/D3: the compose form's "Preview as <recipient>" control.
 * Compose has no first-class stored templates (the organiser always types an
 * ad-hoc subject/body), so there is no template picker to test here — only
 * that the control renders through `previewMessage` and shows what the
 * server sends back, scoped to the currently checked recipients when the
 * audience is an explicit selection.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import userEvent from '@testing-library/user-event';

const queryResource = vi.fn();
const getComposeAudiences = vi.fn();
const previewMessage = vi.fn();
const composeMessage = vi.fn();
const getBulkJob = vi.fn();

vi.mock('../api', () => ({
  queryResource: (resource: string) => (params: unknown) => queryResource(resource, params),
  getComposeAudiences: (...args: unknown[]) => getComposeAudiences(...args),
  previewMessage: (...args: unknown[]) => previewMessage(...args),
  composeMessage: (...args: unknown[]) => composeMessage(...args),
  getBulkJob: (...args: unknown[]) => getBulkJob(...args),
  invitePortal: vi.fn(),
  retryMessage: vi.fn(),
}));

import { ComposeForm } from './messaging';

const contact = (id: string, first: string, email: string) => ({
  id,
  event_id: 'ev',
  email,
  first_name: first,
  last_name: 'Speaker',
});

beforeEach(() => {
  queryResource.mockReset();
  getComposeAudiences.mockReset();
  previewMessage.mockReset();
  composeMessage.mockReset();
  getBulkJob.mockReset();
  getComposeAudiences.mockResolvedValue({
    items: [
      { audience: 'all_contacts', count: 5 },
      { audience: 'speakers', count: 2 },
      { audience: 'accepted_speakers', count: 1 },
    ],
    merge_fields: [{ field: 'first_name', description: 'Recipient first name' }],
  });
});

describe('ComposeForm preview control', () => {
  it('scopes the preview picker to checked recipients and renders the server response', async () => {
    const user = userEvent.setup();
    queryResource.mockResolvedValue({
      items: [contact('c1', 'Ada', 'ada@example.com'), contact('c2', 'Alan', 'alan@example.com')],
      total: 2,
    });
    previewMessage.mockResolvedValue({
      subject: 'Hello Ada',
      body_text: 'Hi Ada Speaker, welcome.',
      body_html: '<p>Hi Ada Speaker, welcome.</p>',
    });

    render(<ComposeForm onSubmit={vi.fn()} onCancel={() => {}} title="New message" />);

    await user.selectOptions(screen.getByLabelText('Recipients'), 'selected');
    const contactsSelect = await screen.findByLabelText('Contacts');
    await user.selectOptions(contactsSelect, ['c1']);

    // userEvent.type treats `{`/`}` as special keys, so set these fields
    // directly — the values themselves (merge-field syntax) are what's under
    // test, not the typing interaction.
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hello {{first_name}}' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Hi {{first_name}} Speaker, welcome.' } });

    // Only the checked contact (Ada) is offered, not Alan.
    const previewSelect = screen.getByLabelText('Preview as') as HTMLSelectElement;
    const options = Array.from(previewSelect.options).map((o) => o.textContent ?? '');
    expect(options.some((t) => t.includes('ada@example.com'))).toBe(true);
    expect(options.some((t) => t.includes('alan@example.com'))).toBe(false);

    await user.selectOptions(previewSelect, 'c1');
    await user.click(screen.getByRole('button', { name: /^Preview$/ }));

    await waitFor(() => expect(previewMessage).toHaveBeenCalled());
    expect(previewMessage).toHaveBeenCalledWith({
      subject: 'Hello {{first_name}}',
      body: 'Hi {{first_name}} Speaker, welcome.',
      contact_id: 'c1',
    });
    expect(await screen.findByText('Hello Ada')).toBeTruthy();
    expect(screen.getByText('Hi Ada Speaker, welcome.')).toBeTruthy();
  });

  it('surfaces a server error from the preview call without touching send', async () => {
    const user = userEvent.setup();
    queryResource.mockResolvedValue({ items: [contact('c1', 'Ada', 'ada@example.com')], total: 1 });
    previewMessage.mockRejectedValue(new Error('contact_not_found'));

    render(<ComposeForm onSubmit={vi.fn()} onCancel={() => {}} title="New message" />);

    await user.selectOptions(screen.getByLabelText('Recipients'), 'selected');
    const contactsSelect = await screen.findByLabelText('Contacts');
    await user.selectOptions(contactsSelect, ['c1']);
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Hi' } });
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Body' } });

    await user.selectOptions(screen.getByLabelText('Preview as'), 'c1');
    await user.click(screen.getByRole('button', { name: /^Preview$/ }));

    expect((await screen.findByRole('alert')).textContent).toContain('contact_not_found');
    expect(composeMessage).not.toHaveBeenCalled();
  });
});
