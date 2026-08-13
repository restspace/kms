// Room deletion safety (eval defect: a lightweight inline confirm, then the
// room and its session assignments were simply gone). The confirm must name
// how many scheduled sessions the delete detaches, and the deletion gets an
// Undo toast that restores the room and re-points those sessions.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/preact'

const {
  listRoomsMock,
  listTracksMock,
  listFormatsMock,
  getRoomUsageMock,
  deleteRoomMock,
  restoreRoomMock,
  appConfirmMock,
} = vi.hoisted(() => ({
  listRoomsMock: vi.fn(),
  listTracksMock: vi.fn(),
  listFormatsMock: vi.fn(),
  getRoomUsageMock: vi.fn(),
  deleteRoomMock: vi.fn(),
  restoreRoomMock: vi.fn(),
  appConfirmMock: vi.fn(),
}))

vi.mock('../api', async () => {
  const actual = await vi.importActual<typeof import('../api')>('../api')
  return {
    ...actual,
    listRooms: listRoomsMock,
    listTracks: listTracksMock,
    listFormats: listFormatsMock,
    getRoomUsage: getRoomUsageMock,
    deleteRoom: deleteRoomMock,
    restoreRoom: restoreRoomMock,
  }
})

vi.mock('../components/dialogs', async () => {
  const actual = await vi.importActual<typeof import('../components/dialogs')>('../components/dialogs')
  return { ...actual, appConfirm: appConfirmMock }
})

import { RoomsTracksCard } from './RoomsTracksCard'

const hallA = { id: 'room-1', event_id: 'evt-1', name: 'Hall A', capacity: 100, position: 0, notes: null }

beforeEach(() => {
  for (const fn of [listRoomsMock, listTracksMock, listFormatsMock, getRoomUsageMock, deleteRoomMock, restoreRoomMock, appConfirmMock]) {
    fn.mockReset()
  }
  listRoomsMock.mockResolvedValue({ items: [hallA] })
  listTracksMock.mockResolvedValue({ items: [] })
  listFormatsMock.mockResolvedValue({ items: [] })
})

describe('RoomsTracksCard — room delete', () => {
  it('names the scheduled-session count in the confirm and cancels cleanly', async () => {
    getRoomUsageMock.mockResolvedValue({ session_count: 3, scheduled_count: 2 })
    appConfirmMock.mockResolvedValue(false)

    render(<RoomsTracksCard />)
    fireEvent.click(await screen.findByLabelText('Remove room'))

    await waitFor(() => expect(appConfirmMock).toHaveBeenCalled())
    const [message] = appConfirmMock.mock.calls[0] as [string]
    expect(message).toContain('Delete "Hall A"?')
    expect(message).toContain('2 scheduled sessions are in this room')
    expect(deleteRoomMock).not.toHaveBeenCalled()
  })

  it('says so when no scheduled sessions are affected', async () => {
    getRoomUsageMock.mockResolvedValue({ session_count: 0, scheduled_count: 0 })
    appConfirmMock.mockResolvedValue(false)

    render(<RoomsTracksCard />)
    fireEvent.click(await screen.findByLabelText('Remove room'))

    await waitFor(() => expect(appConfirmMock).toHaveBeenCalled())
    const [message] = appConfirmMock.mock.calls[0] as [string]
    expect(message).toContain('No scheduled sessions are in this room.')
  })

  it('deletes with an Undo toast that restores the room and its sessions', async () => {
    getRoomUsageMock.mockResolvedValue({ session_count: 2, scheduled_count: 2 })
    appConfirmMock.mockResolvedValue(true)
    deleteRoomMock.mockResolvedValue({ ok: true, room: hallA, detached_session_ids: ['s1', 's2'] })
    restoreRoomMock.mockResolvedValue({ ok: true, room: hallA, restored_sessions: 2 })

    render(<RoomsTracksCard />)
    fireEvent.click(await screen.findByLabelText('Remove room'))

    await waitFor(() => expect(deleteRoomMock).toHaveBeenCalledWith('room-1'))
    expect(
      await screen.findByText('Room "Hall A" deleted — 2 sessions kept their slot without a room.'),
    ).toBeTruthy()

    fireEvent.click(screen.getByText('Undo'))
    await waitFor(() => expect(restoreRoomMock).toHaveBeenCalledWith(hallA, ['s1', 's2']))
    // The toast clears and the room list is re-fetched (mount + after undo).
    await waitFor(() => expect(listRoomsMock).toHaveBeenCalledTimes(2))
    expect(screen.queryByText(/kept their slot without a room/)).toBeNull()
  })

  it('still confirms (with generic wording) when the usage lookup fails', async () => {
    getRoomUsageMock.mockRejectedValue(new Error('offline'))
    appConfirmMock.mockResolvedValue(false)

    render(<RoomsTracksCard />)
    fireEvent.click(await screen.findByLabelText('Remove room'))

    await waitFor(() => expect(appConfirmMock).toHaveBeenCalled())
    const [message] = appConfirmMock.mock.calls[0] as [string]
    expect(message).toContain('Any scheduled sessions in this room keep their slot but lose the room.')
  })
})
