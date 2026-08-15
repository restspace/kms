import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/preact'

const { listTagsMock, createTagMock, updateTagMock, deleteTagMock, restoreTagMock, getTagUsageMock, appConfirmMock } =
  vi.hoisted(() => ({
    listTagsMock: vi.fn(),
    createTagMock: vi.fn(),
    updateTagMock: vi.fn(),
    deleteTagMock: vi.fn(),
    restoreTagMock: vi.fn(),
    getTagUsageMock: vi.fn(),
    appConfirmMock: vi.fn(),
  }))

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    listTags: listTagsMock,
    createTag: createTagMock,
    updateTag: updateTagMock,
    deleteTag: deleteTagMock,
    restoreTag: restoreTagMock,
    getTagUsage: getTagUsageMock,
  }
})

vi.mock('../components/dialogs', async () => {
  const actual = await vi.importActual<typeof import('../components/dialogs')>('../components/dialogs')
  return { ...actual, appConfirm: appConfirmMock }
})

import { TagsCard } from './TagsCard'

const tag = (name: string, over: Partial<{ id: string; color: string | null }> = {}) => ({
  id: over.id ?? `tag-${name}`,
  event_id: 'evt-1',
  name,
  color: over.color ?? null,
})

beforeEach(() => {
  listTagsMock.mockReset()
  createTagMock.mockReset()
  updateTagMock.mockReset()
  deleteTagMock.mockReset()
  restoreTagMock.mockReset()
  getTagUsageMock.mockReset()
  appConfirmMock.mockReset()
  listTagsMock.mockResolvedValue({ items: [tag('needs AV')] })
  getTagUsageMock.mockResolvedValue({ submission_count: 0, contact_count: 0 })
})

describe('TagsCard', () => {
  it('creates nothing until a name is committed', async () => {
    render(<TagsCard />)
    fireEvent.click(await screen.findByRole('button', { name: '+ Add tag' }))

    // The input alone must not have created a tag — the whole point of
    // name-first adding (a stray click used to leave a "New tag 3" behind).
    const input = await screen.findByLabelText('New tag name')
    expect(createTagMock).not.toHaveBeenCalled()

    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByLabelText('New tag name')).toBeNull())
    expect(createTagMock).not.toHaveBeenCalled()
  })

  it('adds a tag on Enter and keeps the list in name order', async () => {
    createTagMock.mockResolvedValue(tag('first-timer'))
    render(<TagsCard />)
    await screen.findByDisplayValue('needs AV')

    fireEvent.click(screen.getByRole('button', { name: '+ Add tag' }))
    const input = await screen.findByLabelText('New tag name')
    fireEvent.input(input, { target: { value: '  first-timer  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(createTagMock).toHaveBeenCalledWith({ name: 'first-timer' }))
    const names = (await screen.findAllByLabelText('Tag name')).map((el) => (el as HTMLInputElement).value)
    expect(names).toEqual(['first-timer', 'needs AV'])
  })

  it('names the blast radius before deleting, then offers Undo', async () => {
    getTagUsageMock.mockResolvedValue({ submission_count: 3, contact_count: 1 })
    appConfirmMock.mockResolvedValue(true)
    deleteTagMock.mockResolvedValue({
      ok: true,
      tag: tag('needs AV'),
      submission_ids: ['sub-1', 'sub-2', 'sub-3'],
      contact_ids: ['con-1'],
    })
    restoreTagMock.mockResolvedValue({ ok: true, tag: tag('needs AV') })

    render(<TagsCard />)
    fireEvent.click(await screen.findByLabelText('Remove tag'))

    await waitFor(() => expect(appConfirmMock).toHaveBeenCalled())
    expect(appConfirmMock.mock.calls[0]?.[0]).toContain('3 submissions and 1 contact will lose it')

    await screen.findByText(/removed from 4 records/)
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() =>
      expect(restoreTagMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'needs AV' }), ['sub-1', 'sub-2', 'sub-3'], ['con-1']),
    )
  })

  it('surfaces a duplicate-name rejection and puts the stored name back', async () => {
    listTagsMock.mockResolvedValue({ items: [tag('needs AV'), tag('keynote material')] })
    updateTagMock.mockRejectedValue(new Error('A tag with that name already exists on this event.'))

    render(<TagsCard />)
    const row = (await screen.findAllByLabelText('Tag name'))[1] as HTMLInputElement
    fireEvent.input(row, { target: { value: 'needs AV' } })
    // preact/compat maps onBlur to a focusout listener; fireEvent.blur
    // dispatches the non-bubbling native blur, which never reaches it.
    row.dispatchEvent(new Event('focusout', { bubbles: true }))

    await waitFor(() => expect(updateTagMock).toHaveBeenCalledWith('tag-keynote material', { name: 'needs AV' }))
    await screen.findByText('A tag with that name already exists on this event.')
    // Reloaded rather than left showing the name the server refused.
    await waitFor(() => expect(listTagsMock).toHaveBeenCalledTimes(2))
  })
})
