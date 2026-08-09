# Pending Issues

Open issues found by testing that are **not** closed and **not** simply deferred feature work.
Each needs a decision or an investigation a test-and-fix loop could not settle on its own.

Deferred *feature* gaps (unbuilt things) live in `manual-review-1.md`; the run history lives in
`e2e-journal.md`.

---

## PI-1 · Invited session may move silently via the Move dialog

| | |
|---|---|
| **Status** | Open — not reproducible on demand |
| **Severity** | High if real: it breaks a stated guarantee about speaker communications |
| **Requirement** | FR-COMM-6; `docs/07-agenda-and-scheduling.md` §6 — "Invited sessions never change silently" |
| **Found** | E2E phase U, step M4.9, run `u-01` (2026-08-09) |
| **Artefacts** | `tests/screenshots/u-01/m4.9.png`; `tests/unhappy-paths-e2e.md` M4.9 |

### Symptom

Moving an **already-invited** session through the **Move dialog** applied and persisted the move
with no "notify speakers?" confirmation of any kind. The expected behaviour is a prompt titled
*Moving an invited session*, offering *Send updated invite* / *Skip the email*, where declining
still applies the move but queues no `schedule_changed` message.

### The two observations, which disagree

**Runner (`u-01`) — saw the silent move.** Opened the Move dialog for SESS-1, changed Room,
pressed Save; the block moved and persisted, no dialog appeared. Reproduced twice — the second
time after a full reload of `/app`, with `/app/api/agenda` reporting SESS-1 `invited=1`, so it was
not obviously stale client state. At that point 6 of 7 sessions were `invited=1`, following the
invite send performed earlier in the same run (step M4.7).

**Fixer (`u-01f`) — could not reproduce it.** On a clean seed `calendar_invites` is empty, so no
session is invited at all; the runner's `invited=1` was created by that run's own send. The fixer
recreated the state by inserting a `method='REQUEST'` invite row, confirmed `/app/api/agenda`
reported `invited=1`, then drove the dialog twice — via the `M` key from the Day grid changing only
the room, and via a List-view row double-click changing the start time. **Both raised the prompt**,
and *Skip* applied the move with no message queued. It changed no code, correctly declining to fix
a symptom it could not observe.

### What the code rules out

The obvious explanation — "the Move dialog has its own save path that skips the guard" — is
**wrong**, and worth recording so nobody re-investigates it:

- The guard is in `commitSchedule`: `apps/admin/src/agenda/AgendaSection.tsx:187`,
  `if (session.invited === 1)`.
- The Move dialog's `onSave` calls that same `commitSchedule`
  (`AgendaSection.tsx:535-537`), exactly as the drag path does.

So both paths provably share one guard. The dialog cannot "bypass" it. The only way a move can go
through silently is if, at that moment, **`session.invited` was not the number `1` in client
state**.

`session` comes from the `sessionById` memo (`AgendaSection.tsx:107`, read at `:172`), which is
built from `data.sessions` — client state, not a fresh read.

### Leading hypothesis

`invited` was stale (or the wrong type) in client state when the dialog saved.

Two mechanisms are worth checking, in this order:

1. **The send-confirmations response is applied as-is.** The button calls `runAction(...)`
   (`AgendaSection.tsx:363-371`), and `runAction` does `applyPayload(p)` on the response
   (`:323-334`). If the server computes that payload *before* the invite rows exist — plausible,
   since the mailer uses a leased outbox and delivery is asynchronous — then `invited` stays `0`
   in client state after the send, even though it becomes `1` server-side once the outbox drains.
   A later `GET /app/api/agenda` would then report `1` while the SPA still holds `0`. This fits
   both observations: the runner sent invites and then moved; the fixer never sent anything and
   loaded a page whose payload already said `1`.
2. **Type mismatch.** The guard is strict (`=== 1`). A payload delivering `invited` as `"1"` from
   one route and `1` from another would silently skip the prompt on the first.

Local commits preserve the field (`{ ...s, ...patch }`, `AgendaSection.tsx:208`), so the staleness
would have to originate at an `applyPayload`, not at a drag or a move.

### How to reproduce (the runner's exact sequence, which the fixer did not replicate)

1. `npm run seed:local` — clean baseline, `calendar_invites` empty.
2. Schedule enough sessions that **Send confirmations** shows a non-zero count.
3. Press **Send confirmations** and let it report queued invites. Do **not** reload.
4. Open the Move dialog on one of those sessions, change the room, Save.
5. Observe whether the prompt appears.
6. Repeat with a reload between steps 3 and 4 to isolate stale state from a genuine guard failure.

At step 4, compare three values: what `GET /app/api/agenda` returns for that session's `invited`,
what the send-confirmations response payload carried, and what `sessionById.get(id).invited` holds
in the component (type included, not just value).

### Next step

Confirm or kill hypothesis 1 first — it is cheap to test and would explain both accounts at once.
If it holds, the fix is to make the invited state the client trusts come from a payload written
after the invite rows exist (refetch after the send, or have the send response reflect the queued
invites), rather than to touch the guard, which is correct as written.

Until then the guarantee in `docs/07` §6 should be treated as unproven for the send-then-move path.
