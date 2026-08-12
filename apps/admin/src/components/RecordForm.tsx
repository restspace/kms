import React, { useCallback, useMemo, useRef, useState } from 'react';
import { isValidEmailShape, isValidHandleOrUrlShape, isValidUrlShape } from '@kms/core';
import { toReadableText } from '../utility';
import { stableSerialize } from '../utils/stableSerialize';
import type { SchemaFormChangeHandler, SchemaFormChangeMeta } from './DataTabManager';
import './RecordForm.css';

/**
 * Minimal generic create/edit form used by DataTabManager when a tab supplies a
 * JSON Schema but no custom createComponent/editComponent.
 *
 * This is a deliberately small stand-in for the atelyr RecordForm, which renders
 * through @restspace/schema-form with a suite of custom field components. It keeps
 * the same props interface so that stack (or a KMS field_definitions-driven form)
 * can be swapped in later without touching DataTabManager.
 *
 * Supports: top-level properties of type string (text / textarea / date /
 * datetime-local / email / url via `format`), number, integer, boolean, and
 * string enums as selects; `required` validation; dirty tracking; delete.
 * Not supported (yet): nested objects/arrays (rendered as JSON textareas),
 * file uploads, conditional visibility, and related-record dropdowns
 * (`fetchRelatedRecords` is accepted but unused).
 */
export interface RecordFormProps {
  /** JSON Schema defining the form fields. */
  schema: Record<string, any>;
  /** Initial values for the form fields. */
  initialValues?: Record<string, any>;
  /** Handler called when the form is submitted. Returns true on success. */
  onSubmit: (data: Record<string, any>) => Promise<boolean>;
  /** Handler called when the user cancels/closes the form. */
  onCancel: () => void;
  /** Title displayed in the form header. */
  title: string;
  /** Label for the submit button. Defaults to "Create". */
  submitLabel?: string;
  /** Optional schema-form onChange handler for generic create/edit forms. */
  onSchemaFormChange?: SchemaFormChangeHandler;
  /** Context metadata passed to the schema-form change handler. */
  schemaFormMeta?: SchemaFormChangeMeta;
  /** Optional component context (unused by the minimal form). */
  componentContext?: Record<string, any>;
  /** Fetch related records from another tab (unused by the minimal form). */
  fetchRelatedRecords?: (tabName: string, fields: string[]) => Promise<Record<string, any>[]>;
  /** Callback to delete the current record (edit mode only). */
  onDelete?: () => void;
  /** Reports whether the form has unsaved changes. */
  onDirtyChange?: (isDirty: boolean) => void;
}

interface PropertySchema {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  enum?: unknown[];
  readOnly?: boolean;
  default?: unknown;
}

const isEmpty = (value: unknown): boolean =>
  value === undefined || value === null || (typeof value === 'string' && value.trim() === '');

/**
 * A submit-time error with a recovery affordance (F13: duplicate-contact
 * dead end). `onSubmit` throws this instead of a plain Error to have the
 * form render an extra button next to the error message — e.g. "Open the
 * existing contact" alongside "A contact with this email already exists".
 */
export class RecordFormActionableError extends Error {
  constructor(
    message: string,
    readonly action: { label: string; onClick: () => void },
  ) {
    super(message);
  }
}

interface SubmitError {
  message: string;
  action?: { label: string; onClick: () => void };
}

export const RecordForm: React.FC<RecordFormProps> = ({
  schema,
  initialValues,
  onSubmit,
  onCancel,
  title,
  submitLabel = 'Create',
  onSchemaFormChange,
  schemaFormMeta,
  onDelete,
  onDirtyChange
}) => {
  const [liveSchema, setLiveSchema] = useState<Record<string, any>>(schema);
  const [value, setValue] = useState<Record<string, any>>(() => {
    const seeded: Record<string, any> = { ...(initialValues ?? {}) };
    for (const [key, prop] of Object.entries((schema.properties ?? {}) as Record<string, PropertySchema>)) {
      if (seeded[key] === undefined && prop.default !== undefined) {
        seeded[key] = prop.default;
      }
    }
    return seeded;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const initialSignatureRef = useRef<string | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const schemaRef = useRef(liveSchema);
  schemaRef.current = liveSchema;

  const properties = useMemo(
    () => Object.entries((liveSchema.properties ?? {}) as Record<string, PropertySchema>),
    [liveSchema]
  );
  const requiredFields = useMemo(
    () => new Set<string>(Array.isArray(liveSchema.required) ? liveSchema.required : []),
    [liveSchema]
  );

  if (initialSignatureRef.current === null) {
    initialSignatureRef.current = stableSerialize(value);
  }

  const changeHelpers = useMemo(() => ({
    setValue,
    setSchema: setLiveSchema,
    getValue: () => valueRef.current,
    getSchema: () => schemaRef.current
  }), []);

  const setField = useCallback((field: string, nextFieldValue: unknown) => {
    setValue((prev) => {
      const next = { ...prev, [field]: nextFieldValue };
      onDirtyChange?.(stableSerialize(next) !== initialSignatureRef.current);
      if (onSchemaFormChange && schemaFormMeta) {
        onSchemaFormChange({
          ...schemaFormMeta,
          value: next,
          path: [field],
          errors: null,
          action: 0,
          helpers: changeHelpers
        });
      }
      return next;
    });
  }, [changeHelpers, onDirtyChange, onSchemaFormChange, schemaFormMeta]);

  /**
   * Validates a single field's current value: required-ness first, then
   * (for non-empty string values) the format-specific shape checks shared
   * with the rest of the app via `@kms/core`'s `isValidEmailShape`/
   * `isValidUrlShape`. Returns null when the value is valid.
   */
  const validateFieldValue = useCallback((key: string, prop: PropertySchema, rawValue: unknown): string | null => {
    if (requiredFields.has(key) && prop.type !== 'boolean' && isEmpty(rawValue)) {
      return 'This field is required';
    }
    if (!isEmpty(rawValue) && typeof rawValue === 'string') {
      if (prop.format === 'email' && !isValidEmailShape(rawValue)) {
        return 'Enter a valid email address';
      }
      if ((prop.format === 'url' || prop.format === 'uri') && !isValidUrlShape(rawValue)) {
        return 'Enter a valid link (http:// or https://)';
      }
      if (prop.format === 'social-handle' && !isValidHandleOrUrlShape(rawValue)) {
        return 'Enter a handle (e.g. @name) or a full link';
      }
    }
    return null;
  }, [requiredFields]);

  /** Validates on blur so format errors surface before the user reaches Save. */
  const handleFieldBlur = useCallback((key: string, prop: PropertySchema) => {
    const message = validateFieldValue(key, prop, valueRef.current[key]);
    setErrors((prev) => {
      if (!message) {
        if (!(key in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[key];
        return next;
      }
      if (prev[key] === message) {
        return prev;
      }
      return { ...prev, [key]: message };
    });
  }, [validateFieldValue]);

  const handleSubmit = useCallback(async (event: React.FormEvent) => {
    event.preventDefault();
    // A new attempt clears the previous failure, so a stale flash never sits
    // beside a fresh validation error.
    setSubmitError(null);
    const nextErrors: Record<string, string> = {};
    for (const [key, prop] of properties) {
      const message = validateFieldValue(key, prop, valueRef.current[key]);
      if (message) {
        nextErrors[key] = message;
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      // Block save while any field is invalid.
      return;
    }
    setIsSubmitting(true);
    try {
      const success = await onSubmit(valueRef.current);
      if (!success) {
        setSubmitError({ message: 'The record could not be saved.' });
      }
    } catch (err) {
      if (err instanceof RecordFormActionableError) {
        setSubmitError({ message: err.message, action: err.action });
      } else {
        setSubmitError({ message: err instanceof Error ? err.message : 'Unexpected error.' });
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [onSubmit, properties, validateFieldValue]);

  const renderField = (key: string, prop: PropertySchema) => {
    const fieldId = `record-form-${key}`;
    const errorId = `${fieldId}-error`;
    const label = prop.title ?? toReadableText(key);
    const raw = value[key];
    const common = {
      id: fieldId,
      disabled: isSubmitting || prop.readOnly,
      'aria-invalid': errors[key] ? true : undefined,
      'aria-describedby': errors[key] ? errorId : undefined,
      onBlur: () => handleFieldBlur(key, prop)
    };

    let control: React.ReactNode;

    if (Array.isArray(prop.enum)) {
      control = (
        <select
          {...common}
          value={raw === undefined || raw === null ? '' : String(raw)}
          onChange={(e) => setField(key, e.target.value === '' ? undefined : e.target.value)}
        >
          <option value="">—</option>
          {prop.enum.map((option) => (
            <option key={String(option)} value={String(option)}>
              {toReadableText(String(option))}
            </option>
          ))}
        </select>
      );
    } else if (prop.type === 'boolean') {
      return (
        <div key={key} className="record-form-field record-form-field-checkbox">
          <label htmlFor={fieldId}>
            <input
              {...common}
              type="checkbox"
              checked={Boolean(raw)}
              onChange={(e) => setField(key, e.target.checked)}
            />
            <span>{label}</span>
          </label>
          {prop.description && <p className="record-form-help">{prop.description}</p>}
        </div>
      );
    } else if (prop.type === 'number' || prop.type === 'integer') {
      control = (
        <input
          {...common}
          type="number"
          step={prop.type === 'integer' ? 1 : 'any'}
          value={raw === undefined || raw === null ? '' : String(raw)}
          onChange={(e) => setField(key, e.target.value === '' ? undefined : Number(e.target.value))}
        />
      );
    } else if (prop.type === 'string' || prop.type === undefined) {
      if (prop.format === 'textarea') {
        control = (
          <textarea
            {...common}
            rows={4}
            value={raw ?? ''}
            onChange={(e) => setField(key, e.target.value)}
          />
        );
      } else {
        const inputType = prop.format === 'date' ? 'date'
          : prop.format === 'date-time' ? 'datetime-local'
          : prop.format === 'email' ? 'email'
          : prop.format === 'url' || prop.format === 'uri' ? 'url'
          : 'text';
        control = (
          <input
            {...common}
            type={inputType}
            value={raw ?? ''}
            onChange={(e) => setField(key, e.target.value)}
          />
        );
      }
    } else {
      // Nested objects/arrays: raw JSON editing as a stopgap.
      control = (
        <textarea
          {...common}
          rows={4}
          className="record-form-json"
          value={raw === undefined ? '' : typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2)}
          onChange={(e) => {
            try {
              setField(key, e.target.value === '' ? undefined : JSON.parse(e.target.value));
            } catch {
              setField(key, e.target.value);
            }
          }}
        />
      );
    }

    return (
      <div key={key} className="record-form-field">
        <label htmlFor={fieldId}>
          {label}
          {requiredFields.has(key) && <span className="record-form-required" aria-hidden="true"> *</span>}
        </label>
        {control}
        {prop.description && <p className="record-form-help">{prop.description}</p>}
        {errors[key] && <p id={errorId} className="record-form-error" role="alert">{errors[key]}</p>}
      </div>
    );
  };

  return (
    <form className="record-form" onSubmit={handleSubmit} noValidate>
      <div className="record-form-header">
        <h2>{title}</h2>
      </div>
      {submitError && (
        <div className="record-form-submit-error" role="alert">
          <span>{submitError.message}</span>
          {submitError.action && (
            <button type="button" className="record-form-submit-error-action" onClick={submitError.action.onClick}>
              {submitError.action.label}
            </button>
          )}
        </div>
      )}
      <div className="record-form-fields">
        {properties.map(([key, prop]) => renderField(key, prop))}
      </div>
      <div className="record-form-actions">
        {onDelete && (
          <button
            type="button"
            className="record-form-delete"
            onClick={onDelete}
            disabled={isSubmitting}
          >
            Delete
          </button>
        )}
        <span className="record-form-actions-spacer" />
        <button type="button" className="record-form-cancel" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </button>
        <button type="submit" className="record-form-submit" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : submitLabel}
        </button>
      </div>
    </form>
  );
};
