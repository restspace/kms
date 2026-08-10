// Conditional-logic evaluator, routing-rule engine and submission validation
// (docs/02 §3, docs/04 §3–4). Pure TypeScript with no runtime deps: the same
// code runs in the Worker (server-side re-evaluation on submit), the public
// wizard island (live show/hide) and the admin builder (editor previews).

// ---------------------------------------------------------------------------
// Question shape shared across the three surfaces
// ---------------------------------------------------------------------------

export type FieldType =
  | 'text'
  | 'textarea'
  | 'wysiwyg'
  | 'number'
  | 'email'
  | 'phone'
  | 'url'
  | 'date'
  | 'datetime'
  | 'dropdown'
  | 'multiselect'
  | 'checkbox'
  | 'radio'
  | 'file'
  | 'heading';

export interface QuestionOption {
  value: string;
  label: string;
  color?: string;
}

/** A form question as served to clients (form_questions joined to its field). */
export interface QuestionDef {
  id: string;
  section: 'abstract' | 'participant';
  /** FieldDefinition key, e.g. 'title', 'format' — stable across forms. */
  field_key: string;
  field_id: string;
  label: string;
  help_text: string | null;
  type: FieldType;
  position: number;
  required: boolean;
  locked: boolean;
  options: QuestionOption[] | null;
  max_chars: number | null;
  visibility: ConditionalRule | null;
}

export type AnswerValue = string | number | boolean | string[] | null | undefined;
export type Answers = Record<string, AnswerValue>;

// ---------------------------------------------------------------------------
// Conditional logic
// ---------------------------------------------------------------------------

export type ConditionOp =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'is_any_of'
  | 'is_empty'
  | 'is_not_empty'
  | 'gt'
  | 'lt';

export interface Condition {
  question_id: string;
  op: ConditionOp;
  value?: unknown;
}

export interface ConditionalRule {
  action: 'show' | 'hide';
  match: 'all' | 'any';
  conditions: Condition[];
}

const isEmptyValue = (v: AnswerValue): boolean =>
  v === undefined ||
  v === null ||
  v === false ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

const asArray = (v: AnswerValue): string[] =>
  Array.isArray(v) ? v.map(String) : isEmptyValue(v) ? [] : [String(v)];

export function evalCondition(condition: Condition, answers: Answers): boolean {
  const value = answers[condition.question_id];
  switch (condition.op) {
    case 'equals':
      return asArray(value).length === 1 && asArray(value)[0] === String(condition.value);
    case 'not_equals':
      return !(asArray(value).length === 1 && asArray(value)[0] === String(condition.value));
    case 'contains':
      return asArray(value).includes(String(condition.value));
    case 'not_contains':
      return !asArray(value).includes(String(condition.value));
    case 'is_any_of': {
      const wanted = Array.isArray(condition.value)
        ? condition.value.map(String)
        : [String(condition.value)];
      return asArray(value).some((v) => wanted.includes(v));
    }
    case 'is_empty':
      return isEmptyValue(value);
    case 'is_not_empty':
      return !isEmptyValue(value);
    case 'gt':
      return typeof value === 'number' && value > Number(condition.value);
    case 'lt':
      return typeof value === 'number' && value < Number(condition.value);
    default:
      return false;
  }
}

export function evalRule(rule: ConditionalRule, answers: Answers): boolean {
  if (!rule.conditions || rule.conditions.length === 0) {
    return true; // a rule with no conditions never hides anything
  }
  const results = rule.conditions.map((cond) => evalCondition(cond, answers));
  const matched = rule.match === 'any' ? results.some(Boolean) : results.every(Boolean);
  return rule.action === 'hide' ? !matched : matched;
}

/**
 * Compute the set of visible question ids for one section pass, cascading:
 * questions are evaluated in position order, and an answer to a question that
 * turned out hidden is *not* available to later conditions (a hidden Track
 * can't reveal downstream questions). Rules referencing a later question are
 * ignored by construction — the builder only offers earlier questions.
 */
export function visibleQuestionIds(questions: QuestionDef[], answers: Answers): Set<string> {
  const visible = new Set<string>();
  const effective: Answers = {};
  const ordered = [...questions].sort((a, b) => a.position - b.position);
  for (const q of ordered) {
    const isVisible = q.visibility ? evalRule(q.visibility, effective) : true;
    if (isVisible) {
      visible.add(q.id);
      effective[q.id] = answers[q.id];
    }
  }
  return visible;
}

// ---------------------------------------------------------------------------
// Validation (client preview + authoritative server pass)
// ---------------------------------------------------------------------------

export interface ValidationError {
  question_id: string;
  code: 'required' | 'max_chars' | 'invalid';
  message: string;
}

const plainTextLength = (v: AnswerValue): number => {
  if (typeof v !== 'string') return 0;
  // Strip tags for wysiwyg answers so markup doesn't eat the budget.
  return v.replace(/<[^>]*>/g, '').length;
};

// Lightweight shape checks shared by the admin RecordForm, the public wizard
// and the portal server (manual-review-1.md "basic format validation"):
// deliberately "good enough", not RFC-complete.
export const isValidEmailShape = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

export const isValidUrlShape = (value: string): boolean => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Local or zoned ISO datetimes; seconds optional (matches <input type="datetime-local">).
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

const isValidDate = (value: string): boolean =>
  DATE_RE.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));

const isValidDateTime = (value: string): boolean =>
  DATETIME_RE.test(value) && !Number.isNaN(Date.parse(value.replace(' ', 'T')));

const optionValues = (q: QuestionDef): Set<string> =>
  new Set((q.options ?? []).map((o) => o.value));

/**
 * Validate one section's answers against its visible questions. Hidden
 * questions are never validated; their answers are the caller's to discard
 * (see `discardHiddenAnswers`).
 */
export function validateAnswers(questions: QuestionDef[], answers: Answers): ValidationError[] {
  const errors: ValidationError[] = [];
  const visible = visibleQuestionIds(questions, answers);
  for (const q of questions) {
    if (!visible.has(q.id) || q.type === 'heading') continue;
    const value = answers[q.id];
    if (q.required && isEmptyValue(value)) {
      errors.push({ question_id: q.id, code: 'required', message: `${q.label} is required` });
      continue;
    }
    if (q.max_chars && plainTextLength(value) > q.max_chars) {
      errors.push({
        question_id: q.id,
        code: 'max_chars',
        message: `${q.label} exceeds ${q.max_chars} characters`,
      });
    }
    if (isEmptyValue(value)) continue; // optional and unanswered: nothing further to check
    const invalid = (message: string) =>
      errors.push({ question_id: q.id, code: 'invalid', message: `${q.label} ${message}` });
    switch (q.type) {
      case 'email':
        if (typeof value !== 'string' || !isValidEmailShape(value)) invalid('must be a valid email');
        break;
      case 'number': {
        const n = typeof value === 'number' ? value : Number(value);
        if (typeof value === 'boolean' || Array.isArray(value) || !Number.isFinite(n)) {
          invalid('must be a number');
        }
        break;
      }
      case 'url':
        if (typeof value !== 'string' || !isValidUrlShape(value)) invalid('must be a valid link (http:// or https://)');
        break;
      case 'date':
        if (typeof value !== 'string' || !isValidDate(value)) invalid('must be a valid date (YYYY-MM-DD)');
        break;
      case 'datetime':
        if (typeof value !== 'string' || !isValidDateTime(value)) invalid('must be a valid date and time');
        break;
      case 'dropdown':
      case 'radio': {
        const allowed = optionValues(q);
        if (allowed.size > 0 && (typeof value !== 'string' || !allowed.has(value))) {
          invalid('must be one of the offered options');
        }
        break;
      }
      case 'multiselect': {
        if (!Array.isArray(value)) {
          invalid('must be a list of options');
          break;
        }
        const allowed = optionValues(q);
        if (allowed.size > 0 && value.some((v) => typeof v !== 'string' || !allowed.has(v))) {
          invalid('contains an option that is not offered');
        }
        break;
      }
      case 'checkbox':
        if (typeof value !== 'boolean') invalid('must be checked or unchecked');
        break;
      case 'file':
        // Value is a stored asset id; ownership/scoping is the server's DB-side
        // check — here only the shape is validated.
        if (typeof value !== 'string' || !/^[\w-]{8,}$/.test(value)) invalid('must be an uploaded file');
        break;
      default:
        break;
    }
  }
  return errors;
}

/** Answers for hidden questions are discarded, never stored (docs/04 §3). */
export function discardHiddenAnswers(questions: QuestionDef[], answers: Answers): Answers {
  const visible = visibleQuestionIds(questions, answers);
  const kept: Answers = {};
  for (const q of questions) {
    if (visible.has(q.id) && answers[q.id] !== undefined) {
      kept[q.id] = answers[q.id];
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Category-based routing
// ---------------------------------------------------------------------------

export interface RoutingActions {
  set_track_id?: string;
  assign_evaluation_plan_id?: string;
  add_tag_ids?: string[];
  notify_contact_ids?: string[];
  set_status?: string;
}

export interface RoutingRule {
  id: string;
  when: Condition;
  then: RoutingActions;
}

export interface RoutingConfig {
  rules: RoutingRule[];
  fallback?: RoutingActions;
}

export interface RoutingOutcome extends Required<Pick<RoutingActions, 'add_tag_ids' | 'notify_contact_ids'>> {
  set_track_id?: string;
  assign_evaluation_plan_id?: string;
  set_status?: string;
  /** ids of rules that matched, in order — recorded for auditability. */
  applied_rule_ids: string[];
  used_fallback: boolean;
}

/**
 * Evaluate routing rules in order against the submitted answers. Scalar
 * actions overwrite earlier matches; tag/notify lists accumulate. The
 * fallback applies only when no rule matched (docs/04 §4).
 */
export function applyRouting(config: RoutingConfig | null | undefined, answers: Answers): RoutingOutcome {
  const outcome: RoutingOutcome = {
    add_tag_ids: [],
    notify_contact_ids: [],
    applied_rule_ids: [],
    used_fallback: false,
  };
  const apply = (actions: RoutingActions) => {
    if (actions.set_track_id) outcome.set_track_id = actions.set_track_id;
    if (actions.assign_evaluation_plan_id) outcome.assign_evaluation_plan_id = actions.assign_evaluation_plan_id;
    if (actions.set_status) outcome.set_status = actions.set_status;
    for (const tag of actions.add_tag_ids ?? []) {
      if (!outcome.add_tag_ids.includes(tag)) outcome.add_tag_ids.push(tag);
    }
    for (const cid of actions.notify_contact_ids ?? []) {
      if (!outcome.notify_contact_ids.includes(cid)) outcome.notify_contact_ids.push(cid);
    }
  };

  for (const rule of config?.rules ?? []) {
    if (evalCondition(rule.when, answers)) {
      outcome.applied_rule_ids.push(rule.id);
      apply(rule.then ?? {});
    }
  }
  if (outcome.applied_rule_ids.length === 0 && config?.fallback) {
    outcome.used_fallback = true;
    apply(config.fallback);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// Participant roles config (submission_forms.participant_roles json)
// ---------------------------------------------------------------------------

export type ParticipantRole = 'speaker' | 'co-speaker' | 'moderator' | 'panelist' | 'co-author' | 'co-presenter';

/**
 * Canonical role vocabulary (F14/ABS-11) — the single source of truth other
 * modules should import from rather than hand-rolling their own Set. Must
 * stay in lockstep with the `submission_participants.role` CHECK constraint
 * (packages/db/migrations/0008_participant_roles.sql).
 */
export const ALL_PARTICIPANT_ROLES: readonly ParticipantRole[] = [
  'speaker', 'co-speaker', 'moderator', 'panelist', 'co-author', 'co-presenter',
];

export interface ParticipantRoleConfig {
  role: ParticipantRole;
  min: number;
  max: number | null;
}

// Manual-review item (O4/item 2): the public submit form's role dropdown
// only ever offered 'speaker' for any form an organiser hadn't explicitly
// configured with a `participant_roles` JSON blob (FormBuilder's own
// RolesPanel defaults an unconfigured form to speaker-only too — see
// apps/admin/src/forms/FormBuilder.tsx's RolesPanel), while the organiser
// workspace's ParticipantsEditor always offers the full canonical vocabulary
// (ALL_PARTICIPANT_ROLES) regardless of the originating form — so a
// co-author/co-presenter added to an existing submission from the admin side
// could never have been labelled that way by the submitter themselves.
// 'co-speaker' is added here as the shared minimum baseline both sides now
// agree on for a form nobody has explicitly restricted; an organiser who
// still wants speaker-only can say so explicitly via RolesPanel, same as
// today.
export const DEFAULT_PARTICIPANT_ROLES: ParticipantRoleConfig[] = [
  { role: 'speaker', min: 1, max: null },
  { role: 'co-speaker', min: 0, max: null },
];

export function parseParticipantRoles(json: string | null | undefined): ParticipantRoleConfig[] {
  if (!json) return DEFAULT_PARTICIPANT_ROLES;
  try {
    const parsed = JSON.parse(json) as ParticipantRoleConfig[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_PARTICIPANT_ROLES;
  } catch {
    return DEFAULT_PARTICIPANT_ROLES;
  }
}

// ---------------------------------------------------------------------------
// Runtime config guards (sweep item P1-6): stored JSON for conditional rules,
// routing rules and participant roles is organiser-supplied. Malformed config
// must surface as a 4xx with a field path — never a DB constraint error.
// ---------------------------------------------------------------------------

export interface ConfigIssue {
  path: string;
  message: string;
}

const CONDITION_OPS: ReadonlySet<string> = new Set([
  'equals', 'not_equals', 'contains', 'not_contains', 'is_any_of', 'is_empty', 'is_not_empty', 'gt', 'lt',
]);

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function checkCondition(value: unknown, path: string, issues: ConfigIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'condition must be an object' });
    return;
  }
  if (typeof value.question_id !== 'string' || value.question_id === '') {
    issues.push({ path: `${path}.question_id`, message: 'question_id must be a non-empty string' });
  }
  if (typeof value.op !== 'string' || !CONDITION_OPS.has(value.op)) {
    issues.push({ path: `${path}.op`, message: `op must be one of ${[...CONDITION_OPS].join(', ')}` });
  }
}

/** Validate a form_questions.visibility value. Empty array = no issues. */
export function validateConditionalRuleConfig(value: unknown, basePath = 'visibility'): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (value === null || value === undefined) return issues;
  if (!isRecord(value)) return [{ path: basePath, message: 'rule must be an object' }];
  if (value.action !== 'show' && value.action !== 'hide') {
    issues.push({ path: `${basePath}.action`, message: "action must be 'show' or 'hide'" });
  }
  if (value.match !== 'all' && value.match !== 'any') {
    issues.push({ path: `${basePath}.match`, message: "match must be 'all' or 'any'" });
  }
  if (!Array.isArray(value.conditions)) {
    issues.push({ path: `${basePath}.conditions`, message: 'conditions must be an array' });
  } else {
    value.conditions.forEach((cond, i) => checkCondition(cond, `${basePath}.conditions[${i}]`, issues));
  }
  return issues;
}

function checkRoutingActions(value: unknown, path: string, issues: ConfigIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path, message: 'actions must be an object' });
    return;
  }
  for (const key of ['set_track_id', 'assign_evaluation_plan_id', 'set_status'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      issues.push({ path: `${path}.${key}`, message: `${key} must be a string` });
    }
  }
  for (const key of ['add_tag_ids', 'notify_contact_ids'] as const) {
    const list = value[key];
    if (list !== undefined && (!Array.isArray(list) || list.some((v) => typeof v !== 'string'))) {
      issues.push({ path: `${path}.${key}`, message: `${key} must be an array of ids` });
    }
  }
}

/** Validate a submission_forms.routing_rules value. Empty array = no issues. */
export function validateRoutingConfig(value: unknown, basePath = 'routing_rules'): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (value === null || value === undefined) return issues;
  if (!isRecord(value)) return [{ path: basePath, message: 'routing config must be an object' }];
  if (value.rules !== undefined) {
    if (!Array.isArray(value.rules)) {
      issues.push({ path: `${basePath}.rules`, message: 'rules must be an array' });
    } else {
      value.rules.forEach((rule, i) => {
        const path = `${basePath}.rules[${i}]`;
        if (!isRecord(rule)) {
          issues.push({ path, message: 'rule must be an object' });
          return;
        }
        if (typeof rule.id !== 'string' || rule.id === '') {
          issues.push({ path: `${path}.id`, message: 'rule id must be a non-empty string' });
        }
        checkCondition(rule.when, `${path}.when`, issues);
        if (rule.then !== undefined) checkRoutingActions(rule.then, `${path}.then`, issues);
      });
    }
  }
  if (value.fallback !== undefined) checkRoutingActions(value.fallback, `${basePath}.fallback`, issues);
  return issues;
}

const PARTICIPANT_ROLES: ReadonlySet<string> = new Set(ALL_PARTICIPANT_ROLES);

/** Validate a submission_forms.participant_roles value. Empty array = no issues. */
export function validateParticipantRolesConfig(value: unknown, basePath = 'participant_roles'): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (value === null || value === undefined) return issues;
  if (!Array.isArray(value)) return [{ path: basePath, message: 'participant roles must be an array' }];
  value.forEach((entry, i) => {
    const path = `${basePath}[${i}]`;
    if (!isRecord(entry)) {
      issues.push({ path, message: 'role config must be an object' });
      return;
    }
    if (typeof entry.role !== 'string' || !PARTICIPANT_ROLES.has(entry.role)) {
      issues.push({ path: `${path}.role`, message: `role must be one of ${[...PARTICIPANT_ROLES].join(', ')}` });
    }
    if (typeof entry.min !== 'number' || !Number.isInteger(entry.min) || entry.min < 0) {
      issues.push({ path: `${path}.min`, message: 'min must be a non-negative integer' });
    }
    if (entry.max !== null && (typeof entry.max !== 'number' || !Number.isInteger(entry.max) || entry.max < 0)) {
      issues.push({ path: `${path}.max`, message: 'max must be null or a non-negative integer' });
    }
    if (
      typeof entry.min === 'number' && typeof entry.max === 'number' && entry.max < entry.min
    ) {
      issues.push({ path: `${path}.max`, message: 'max must be at least min' });
    }
  });
  return issues;
}

/** Overall participant cap across all roles (sweep item P1-7). */
export const MAX_PARTICIPANTS_PER_SUBMISSION = 10;
