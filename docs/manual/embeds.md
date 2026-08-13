# Embeds

**Sidebar:** Embeds

Generates embeddable widgets and data feeds — sessions, speakers, agenda — for placing on an
outside website, plus a place to save named configurations you use again and again.

## Saved embeds

A table at the top lists everything you've saved. Per row:

- **Load** — brings that configuration into the generator below, marked as "Loaded."
- **Copy snippet** — rebuilds and copies the embed code straight from the stored settings,
  without needing to load it first.
- **Delete** — asks for confirmation; explains that any copy of the snippet already pasted
  elsewhere keeps working (deleting here only removes it from your saved list).

## Building an embed

Below the saved list is a two-pane generator: your choices on the left, the resulting
snippet/URL/preview on the right.

- **Widget** — pick what you're embedding: Sessions list, Speakers list, Agenda grid, Schedule
  itinerary, or Speaker gallery.
- **Output format** — Styled `<script>` embed, a basic HTML iframe, or a raw feed URL
  (JSON/XML/iCal). Formats that don't apply to the widget you picked are greyed out.
- **Branding** — show or hide the event's header/tab strip; optionally override the accent colour
  with a colour picker.
- **Theme** — font, corner radius, and density (Default/Compact/Cozy/Roomy); optionally override
  the muted text colour.
- **Content** — toggle whether abstracts, speakers, room, and track show on the embedded widget.
- **Filters** — Track and Day dropdowns, populated from the event's live published feed;
  disabled entirely for widgets that can't be filtered (Speakers, Gallery).
- **Frame** — a starting height in pixels, shown only for script/iframe formats. The script embed
  auto-resizes itself after loading; a plain iframe does not, so the starting height matters more
  there.
- **Save** / **Save as new** — saves your current choices under a name. If you loaded an existing
  saved embed, **Save** updates it in place, while **Save as new** clones it instead.
- **Copy** buttons sit on both the snippet and the direct-link outputs.
- A **live preview** iframe on the right renders the actual public page with your current
  settings applied, so you can see what you're about to paste before you paste it.

> **Note:** if the agenda hasn't been published yet, a banner warns that the feed isn't live —
> see [Building the agenda → Publishing](agenda.md#publishing).
