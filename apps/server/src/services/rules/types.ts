import type {
  Condition,
  RuleV2,
  Action,
  Session,
  ServerUser,
  Server,
  GroupEvidence,
} from '@tracearr/shared';

export interface EvaluationContext {
  session: Session;
  serverUser: ServerUser;
  server: Server;
  activeSessions: Session[];
  recentSessions: Session[];
  rule: RuleV2;
  /** All server_user ids belonging to the same identity as serverUser.
   *  Optional so contexts built before a lookup (or in old tests) fall back
   *  to single server_user behavior. */
  identityServerUserIds?: string[];
  /** Violation this match created, if any. Populated by callers that insert
   *  the violation before executing actions; kill_stream needs it to attribute
   *  the eventual queue outcome (killed/skipped/failed) back to the record. */
  violationId?: string | null;
}

export interface EvaluatorResult {
  matched: boolean;
  actual: unknown;
  relatedSessionIds?: string[];
  details?: Record<string, unknown>;
}

export type ConditionEvaluator = (
  context: EvaluationContext,
  condition: Condition
) => EvaluatorResult | Promise<EvaluatorResult>;

/** Non-void executors return which target session ids they successfully
 *  handed to a downstream queue (currently kill_stream only). queueFailure is
 *  set when there were targets to kill but none reached the queue (queue down),
 *  so the caller records the action as failed rather than queued. */
export type ActionExecutorResult = { enqueuedSessionIds?: string[]; queueFailure?: boolean } | void;

export type ActionExecutor = (
  context: EvaluationContext,
  action: Action
) => ActionExecutorResult | Promise<ActionExecutorResult>;

export interface EvaluationResult {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  matchedGroups: number[];
  actions: Action[];
  evidence?: GroupEvidence[];
}
