import { describe, expect, it } from 'vitest';
import {
  isValidEmailShape,
  isValidUrlShape,
  validateAnswers,
  validateConditionalRuleConfig,
  validateParticipantRolesConfig,
  validateRoutingConfig,
  type QuestionDef,
} from './forms';

const q = (over: Partial<QuestionDef>): QuestionDef => ({
  id: 'q1',
  section: 'abstract',
  field_key: 'f',
  field_id: 'fid',
  label: 'Field',
  help_text: null,
  type: 'text',
  position: 1,
  required: false,
  locked: false,
  options: null,
  max_chars: null,
  visibility: null,
  ...over,
});

const errorsFor = (question: QuestionDef, value: unknown) =>
  validateAnswers([question], { [question.id]: value as never });

describe('validateAnswers field matrix', () => {
  it.each([
    // [type-ish question, valid value, invalid value]
    [q({ type: 'email' }), 'a@b.co', 'not-an-email'],
    [q({ type: 'url' }), 'https://example.com/x', 'ftp://example.com'],
    [q({ type: 'url' }), 'http://example.com', 'just words'],
    [q({ type: 'date' }), '2026-08-09', '09/08/2026'],
    [q({ type: 'date' }), '2026-02-28', '2026-13-40'],
    [q({ type: 'datetime' }), '2026-08-09T10:30', 'tomorrow'],
    [q({ type: 'datetime' }), '2026-08-09T10:30:00Z', '2026-08-09T99:99'],
    [q({ type: 'number' }), 42, 'abc'],
    [q({ type: 'number' }), '3.5', 'Infinity'],
    [q({ type: 'checkbox' }), true, 'yes'],
    [
      q({ type: 'dropdown', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }),
      'a',
      'zzz',
    ],
    [
      q({ type: 'radio', options: [{ value: 'a', label: 'A' }] }),
      'a',
      'b',
    ],
    [
      q({ type: 'multiselect', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] }),
      ['a', 'b'],
      ['a', 'zzz'],
    ],
    [q({ type: 'file' }), crypto.randomUUID(), { not: 'a string' }],
  ])('%#: accepts the valid value and rejects the invalid one', (question, valid, invalid) => {
    expect(errorsFor(question as QuestionDef, valid)).toEqual([]);
    const errs = errorsFor(question as QuestionDef, invalid);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]?.code).toBe('invalid');
  });

  it('multiselect must be an array', () => {
    const question = q({ type: 'multiselect', options: [{ value: 'a', label: 'A' }] });
    expect(errorsFor(question, 'a')[0]?.code).toBe('invalid');
  });

  it('optional empty values are not type-checked', () => {
    expect(errorsFor(q({ type: 'email' }), '')).toEqual([]);
    expect(errorsFor(q({ type: 'url' }), undefined)).toEqual([]);
    expect(errorsFor(q({ type: 'checkbox' }), false)).toEqual([]);
  });

  it('required still fires before type checks', () => {
    expect(errorsFor(q({ type: 'email', required: true }), '')[0]?.code).toBe('required');
  });
});

describe('shape helpers', () => {
  it('email shape is x@x.x, not RFC 5322', () => {
    expect(isValidEmailShape('a@b.c')).toBe(true);
    expect(isValidEmailShape('a@b')).toBe(false);
    expect(isValidEmailShape('a b@c.d')).toBe(false);
  });
  it('url shape requires http(s)', () => {
    expect(isValidUrlShape('https://x.dev')).toBe(true);
    expect(isValidUrlShape('javascript:alert(1)')).toBe(false);
  });
});

describe('config guards', () => {
  it('accepts a well-formed conditional rule', () => {
    expect(
      validateConditionalRuleConfig({
        action: 'show',
        match: 'all',
        conditions: [{ question_id: 'q1', op: 'equals', value: 'x' }],
      }),
    ).toEqual([]);
  });

  it('reports paths for malformed conditional rules', () => {
    const issues = validateConditionalRuleConfig({ action: 'blink', match: 'all', conditions: [{ op: 'nope' }] });
    expect(issues.map((i) => i.path)).toEqual(
      expect.arrayContaining(['visibility.action', 'visibility.conditions[0].question_id', 'visibility.conditions[0].op']),
    );
  });

  it('accepts null routing config and reports malformed rules', () => {
    expect(validateRoutingConfig(null)).toEqual([]);
    const issues = validateRoutingConfig({ rules: [{ id: '', when: { op: 'equals' }, then: { add_tag_ids: 'oops' } }] });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.path.includes('add_tag_ids'))).toBe(true);
  });

  it('validates participant role configs', () => {
    expect(validateParticipantRolesConfig([{ role: 'speaker', min: 1, max: null }])).toEqual([]);
    const issues = validateParticipantRolesConfig([{ role: 'dj', min: -1, max: 0 }]);
    expect(issues.some((i) => i.path.endsWith('.role'))).toBe(true);
    expect(issues.some((i) => i.path.endsWith('.min'))).toBe(true);
  });
});
