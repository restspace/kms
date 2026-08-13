# Manual Review 3

## Work

- Add a copy of the Agenda list into Workspace. Have it take Global Filter from Speakers and Events. Allow Room to be optional if not already.  Add a Criteria field which is free text for describing constraints on when it can be scheduled.
- 

## Workspace

Intelligently shorten the titles in details tabs and limit the maximum width of such a tab

Tab header left/right pad should equal left pad of global filter row above it

## Evaluation

Put a col name over the checkbox 'Active'

Evaluation form janks when temporary messages are added at top. Recommend have a sticky status bar across bottom where these messages are shown

## Review

Add a 'Workspace'  link on the RHS of the queue card at the top which jumps to show the Workspace Submission tab with the item set to the global filter

## Seed Data

Can we have seed data for a comments conversation on Ada Lovelace's submission

Can seed data gen command have an optional email in which case all user emails are + variations of this email, so all correspondence gets sent there for testing.

## Agenda

Adding a new session with Room but no date/time, this should show in the Unscheduled column plus in Day view grouped by Rooms, show a pill in the room header with count of sessions with no date/time in this room if there are any. In Day view grouped by Track, show a pill in the room header with a count of sessions with no date/time in the track if any.

Show Track and Room on Unscheduled column cards. When dragging an Unscheduled item with a preset Track or Room on Day view with Track or Room set (respectively), confine the drop position indicator to the relevant Track or Room.

### Nav to Submission

1. Hover-reveal "open" icon button on the card (primary affordance).
A small ↗ icon button (~16px), absolutely positioned in the card's top-right corner, hidden by default and shown on :hover / :focus-within of .tg-block and .tray-card. Crucially it needs onMouseDown={(e) => e.stopPropagation()} so it doesn't start a drag, and onClick stops propagation then calls navigate({ v: 'workspace', tab: 'submissions', rec: s.id }). Give it title="Open submission in Workspace" and aria-label. On grid blocks it should sit opposite the ⚠ conflict flag (flag is top-left via .tg-block-flag), and for blocks too short to fit anything (sub-~20px), it's fine for it simply not to show — the second affordance covers those.

2. A link in the MoveDialog header (keyboard/fallback path).
The MoveDialog is already the card's "details" surface, reachable by Enter or double-click on every card regardless of size. Add an "Open submission ↗" link next to the session title in the dialog header that does the same navigate(...) and closes the dialog. This gives you the accessible route for free — no new keyboard handling on the cards — and works for the tiny blocks where the hover icon doesn't fit.

## Flows to check

- Create event, create form, participant nav to form, enter data, return to admin, view data, edit form, participant add via new form, check data state on admin
- 