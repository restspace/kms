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
    if (q.type === 'email' && typeof value === 'string' && value !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      errors.push({ question_id: q.id, code: 'invalid', message: `${q.label} must be a valid email` });
    }
    if (q.type === 'number' && value !== undefined && value !== null && value !== '' && Number.isNaN(Number(value))) {
      errors.push({ question_id: q.id, code: 'invalid', message: `${q.label} must be a number` });
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

export type ParticipantRole = 'speaker' | 'co-speaker' | 'moderator' | 'panelist';

export interface ParticipantRoleConfig {
  role: ParticipantRole;
  min: number;
  max: number | null;
}

export const DEFAULT_PARTICIPANT_ROLES: ParticipantRoleConfig[] = [
  { role: 'speaker', min: 1, max: null },
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
