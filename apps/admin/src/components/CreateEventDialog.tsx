import { useEffect, useRef, useState } from 'react';
import { isValidUrlShape } from '@kms/core';
import { ModalDialog } from './dialogs';
import { createEvent, type CreateEventInput, type RoomDraft, type TrackDraft } from '../api';
import {
  RoomsRepeatableField,
  TracksRepeatableField,
  type RoomDraftRow,
  type TrackDraftRow,
} from './RoomsTracksFields';
import './RecordForm.css';

/**
 * FR-EVT-1/2: create a new event from the admin shell. Reachable via a
 * "+ New event" affordance next to the event dropdown (App.tsx). Reuses
 * RecordForm.css for field styling rather than inventing a parallel set of
 * form classes for a single dialog.
 */

const EVENT_TYPES = ['conference', 'workshop', 'summit', 'meetup', 'other'] as const;
type EventType = (typeof EVENT_TYPES)[number];

const SLUG_PATTERN = /^[a-z0-9-]{2,64}$/;
const MAX_DESCRIPTION = 1000;

/** Lowercase-kebab suggestion from a display name; the user can still edit it. */
export const slugify = (name: string): string =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

// `Intl.supportedValuesOf` postdates this project's configured TS lib target;
// it's broadly supported at runtime (evergreen browsers) but not in the types.
const intlWithSupportedValuesOf = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };

const timezoneOptions: string[] = (() => {
  try {
    return typeof intlWithSupportedValuesOf.supportedValuesOf === 'function'
      ? intlWithSupportedValuesOf.supportedValuesOf('timeZone')
      : [];
  } catch {
    return [];
  }
})();

export interface CreateEventDialogProps {
  open: boolean;
  onClose: () => void;
  /** Defaults the timezone select — normally the current event's. */
  defaultTimezone: string;
  /** Fired after a successful create with the new event's id. */
  onCreated: (eventId: string) => void;
}

/** New-event dialog (FR-EVT-1/2). */
export function CreateEventDialog({ open, onClose, defaultTimezone, onCreated }: CreateEventDialogProps) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [type, setType] = useState<EventType>('conference');
  const [website, setWebsite] = useState('');
  const [location, setLocation] = useState('');
  const [timezone, setTimezone] = useState(defaultTimezone);
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [description, setDescription] = useState('');
  const [rooms, setRooms] = useState<RoomDraftRow[]>([]);
  const [tracks, setTracks] = useState<TrackDraftRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const nameRef = useRef<HTMLInputElement | null>(null);

  // Reset on every open so a second use never shows the previous attempt's data/errors.
  useEffect(() => {
    if (!open) return;
    setName('');
    setSlug('');
    setSlugTouched(false);
    setType('conference');
    setWebsite('');
    setLocation('');
    setTimezone(defaultTimezone);
    setStartsAt('');
    setEndsAt('');
    setDescription('');
    setRooms([]);
    setTracks([]);
    setErrors({});
    setSubmitError(null);
  }, [open, defaultTimezone]);

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugTouched) setSlug(slugify(value));
  };

  const handleSlugChange = (value: string) => {
    setSlugTouched(true);
    setSlug(value.toLowerCase());
  };

  const validate = (): Record<string, string> => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Name is required.';
    if (!slug.trim()) next.slug = 'Slug is required.';
    else if (!SLUG_PATTERN.test(slug.trim())) {
      next.slug = 'Lowercase letters, numbers and hyphens, 2-64 characters.';
    }
    if (website.trim() && !isValidUrlShape(website.trim())) {
      next.website = 'Must be a valid link (http:// or https://).';
    }
    if (!startsAt) next.starts_at = 'Start date is required.';
    if (!endsAt) next.ends_at = 'End date is required.';
    if (startsAt && endsAt && endsAt < startsAt) {
      next.ends_at = 'End date must be on or after the start date.';
    }
    return next;
  };

  // Resilience: Enter in a single-line text/date/select field submits the
  // form even if the browser's own implicit-submission behavior doesn't
  // kick in (varies by input type and is easy to lose if a future edit
  // wraps a field in extra markup). Skip textareas, where Enter must stay
  // a newline, and skip anything already producing a native submit.
  const handleFormKeyDown = (e: React.KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== 'Enter') return
    const target = e.target as HTMLElement
    if (target.tagName === 'TEXTAREA' || target.tagName === 'BUTTON') return
    e.preventDefault()
    void handleSubmit(e as unknown as React.FormEvent)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    const validation = validate();
    setErrors(validation);
    if (Object.keys(validation).length > 0) return;
    setIsSubmitting(true);
    try {
      const roomDrafts: RoomDraft[] = rooms
        .filter((r) => r.name.trim())
        .map((r) => ({
          name: r.name.trim(),
          capacity: r.capacity.trim() === '' ? null : Number(r.capacity),
        }));
      const trackDrafts: TrackDraft[] = tracks
        .filter((t) => t.name.trim())
        .map((t) => ({ name: t.name.trim(), color: t.color.trim() || null }));
      const payload: CreateEventInput = {
        name: name.trim(),
        slug: slug.trim(),
        type,
        website_url: website.trim() || null,
        location: location.trim() || null,
        timezone,
        starts_at: startsAt,
        ends_at: endsAt,
        description: description.trim() || null,
        rooms: roomDrafts,
        tracks: trackDrafts,
      };
      const result = await createEvent(payload);
      onCreated(result.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not create the event.';
      if (message.toLowerCase().includes('slug')) {
        setErrors((prev) => ({ ...prev, slug: 'That slug is already taken.' }));
      } else {
        setSubmitError(message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ModalDialog
      open={open}
      title="New event"
      onClose={onClose}
      initialFocusRef={nameRef}
      width="md"
      footer={
        <>
          <button type="button" onClick={onClose} disabled={isSubmitting}>Cancel</button>
          <button type="submit" form="create-event-form" className="primary" disabled={isSubmitting}>
            {isSubmitting ? 'Creating…' : 'Create event'}
          </button>
        </>
      }
    >
      <form
        id="create-event-form"
        className="record-form-fields"
        onSubmit={(e) => void handleSubmit(e)}
        onKeyDown={handleFormKeyDown}
      >
        {submitError && <div className="record-form-error" role="alert">{submitError}</div>}
        <div className="record-form-field">
          <label htmlFor="ce-name">
            Name<span className="record-form-required" aria-hidden="true"> *</span>
          </label>
          <input
            id="ce-name"
            ref={nameRef}
            type="text"
            value={name}
            onChange={(e) => handleNameChange((e.target as HTMLInputElement).value)}
            disabled={isSubmitting}
            aria-invalid={errors.name ? true : undefined}
          />
          {errors.name && <p className="record-form-error">{errors.name}</p>}
        </div>
        <div className="record-form-field">
          <label htmlFor="ce-slug">
            Slug<span className="record-form-required" aria-hidden="true"> *</span>
          </label>
          <input
            id="ce-slug"
            type="text"
            value={slug}
            onChange={(e) => handleSlugChange((e.target as HTMLInputElement).value)}
            disabled={isSubmitting}
            aria-invalid={errors.slug ? true : undefined}
          />
          {errors.slug && <p className="record-form-error">{errors.slug}</p>}
        </div>
        <div className="record-form-field">
          <label htmlFor="ce-type">Type</label>
          <select
            id="ce-type"
            value={type}
            onChange={(e) => setType((e.target as HTMLSelectElement).value as EventType)}
            disabled={isSubmitting}
          >
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
            ))}
          </select>
        </div>
        <div className="record-form-field">
          <label htmlFor="ce-website">Website</label>
          <input
            id="ce-website"
            type="url"
            value={website}
            onChange={(e) => setWebsite((e.target as HTMLInputElement).value)}
            disabled={isSubmitting}
            aria-invalid={errors.website ? true : undefined}
          />
          {errors.website && <p className="record-form-error">{errors.website}</p>}
        </div>
        <div className="record-form-field">
          <label htmlFor="ce-location">Location</label>
          <input
            id="ce-location"
            type="text"
            value={location}
            onChange={(e) => setLocation((e.target as HTMLInputElement).value)}
            disabled={isSubmitting}
          />
        </div>
        <div className="record-form-field">
          <label htmlFor="ce-timezone">Timezone</label>
          <select
            id="ce-timezone"
            value={timezone}
            onChange={(e) => setTimezone((e.target as HTMLSelectElement).value)}
            disabled={isSubmitting}
          >
            {(timezoneOptions.includes(timezone) ? timezoneOptions : [timezone, ...timezoneOptions]).map((tz) => (
              <option key={tz} value={tz}>{tz}</option>
            ))}
          </select>
        </div>
        <div className="record-form-field">
          <label htmlFor="ce-starts">
            Starts<span className="record-form-required" aria-hidden="true"> *</span>
          </label>
          <input
            id="ce-starts"
            type="date"
            value={startsAt}
            onChange={(e) => setStartsAt((e.target as HTMLInputElement).value)}
            disabled={isSubmitting}
            aria-invalid={errors.starts_at ? true : undefined}
          />
          {errors.starts_at && <p className="record-form-error">{errors.starts_at}</p>}
        </div>
        <div className="record-form-field">
          <label htmlFor="ce-ends">
            Ends<span className="record-form-required" aria-hidden="true"> *</span>
          </label>
          <input
            id="ce-ends"
            type="date"
            value={endsAt}
            onChange={(e) => setEndsAt((e.target as HTMLInputElement).value)}
            disabled={isSubmitting}
            aria-invalid={errors.ends_at ? true : undefined}
          />
          {errors.ends_at && <p className="record-form-error">{errors.ends_at}</p>}
        </div>
        <div className="record-form-field">
          <label htmlFor="ce-description">
            Description
            <span className="record-form-help"> ({description.length}/{MAX_DESCRIPTION})</span>
          </label>
          <textarea
            id="ce-description"
            rows={4}
            maxLength={MAX_DESCRIPTION}
            value={description}
            onChange={(e) => setDescription((e.target as HTMLTextAreaElement).value.slice(0, MAX_DESCRIPTION))}
            disabled={isSubmitting}
          />
        </div>
        <div className="record-form-field">
          <label>Rooms</label>
          <RoomsRepeatableField rows={rooms} onChange={setRooms} disabled={isSubmitting} />
        </div>
        <div className="record-form-field">
          <label>Tracks</label>
          <TracksRepeatableField rows={tracks} onChange={setTracks} disabled={isSubmitting} />
        </div>
      </form>
    </ModalDialog>
  );
}
