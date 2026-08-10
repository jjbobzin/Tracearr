import { useMemo, useState } from 'react';
import { Plus, Save, Loader2 } from 'lucide-react';
import type {
  ConditionGroup as ConditionGroupType,
  RuleConditions,
  RuleActions,
  Action,
  ViolationSeverity,
  CreateRuleV2Input,
  UpdateRuleV2Input,
  RulesFilterOptions,
} from '@tracearr/shared';
import { IDENTITY_AWARE_CONDITION_FIELDS, INACTIVITY_COMPATIBLE_FIELDS } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConditionGroup } from './ConditionGroup';
import { ActionRow } from './ActionRow';
import {
  FIELD_DEFINITIONS,
  getDefaultOperatorForField,
  getDefaultValueForField,
  createDefaultAction,
  SEVERITY_OPTIONS,
} from '@/lib/rules';
import { useServer } from '@/hooks/useServer';
import { useUsers } from '@/hooks/queries/useUsers';
import { ServerBadge } from '@/components/server';

// Combined rule type that can represent V1 or V2 rules from the API
// The API returns rules with optional V2 fields (conditions, actions, description)
interface RuleInput {
  id: string;
  name: string;
  description?: string | null;
  severity?: ViolationSeverity;
  isActive: boolean;
  serverId?: string | null;
  serverUserId?: string | null;
  userId?: string | null;
  enforceAcrossServers?: boolean;
  // V2 fields
  conditions?: RuleConditions | null;
  actions?: RuleActions | null;
}

type ScopeMode = 'global' | 'server' | 'user' | 'person';

interface RuleBuilderProps {
  initialRule?: RuleInput;
  onSave: (data: CreateRuleV2Input | UpdateRuleV2Input) => Promise<void>;
  onCancel: () => void;
  isLoading?: boolean;
  filterOptions?: RulesFilterOptions;
}

// Create default condition group
function createDefaultConditionGroup(): ConditionGroupType {
  const defaultField = 'concurrent_streams';
  return {
    conditions: [
      {
        field: defaultField,
        operator: getDefaultOperatorForField(defaultField),
        value: getDefaultValueForField(defaultField),
      },
    ],
  };
}

// Create default action
function createDefaultRuleAction(): Action {
  return createDefaultAction('log_only');
}

// Extract conditions from existing rule (V1 or V2)
function extractConditions(rule?: RuleInput): RuleConditions {
  if (!rule) {
    return { groups: [createDefaultConditionGroup()] };
  }

  // V2 rule - has conditions object with groups
  if (rule.conditions && 'groups' in rule.conditions) {
    return rule.conditions;
  }

  // V1 rule or no conditions - return default
  return { groups: [createDefaultConditionGroup()] };
}

// Extract actions from existing rule (V1 or V2)
function extractActions(rule?: RuleInput): RuleActions {
  if (!rule) {
    return { actions: [createDefaultRuleAction()] };
  }

  // V2 rule - has actions object with actions array
  if (rule.actions && 'actions' in rule.actions) {
    return rule.actions;
  }

  // V1 rule or no actions - return default
  return { actions: [createDefaultRuleAction()] };
}

export function RuleBuilder({
  initialRule,
  onSave,
  onCancel,
  isLoading = false,
  filterOptions,
}: RuleBuilderProps) {
  const { servers } = useServer();

  // Derive initial scope mode from existing rule fields
  const initialScopeMode: ScopeMode = initialRule?.userId
    ? 'person'
    : initialRule?.serverUserId
      ? 'user'
      : initialRule?.serverId
        ? 'server'
        : 'global';

  const [name, setName] = useState(initialRule?.name ?? '');
  const [description, setDescription] = useState(initialRule?.description ?? '');
  const [severity, setSeverity] = useState<ViolationSeverity>(initialRule?.severity ?? 'warning');
  const [isActive, setIsActive] = useState(initialRule?.isActive ?? true);
  const [conditions, setConditions] = useState<RuleConditions>(extractConditions(initialRule));
  const [actions, setActions] = useState<RuleActions>(extractActions(initialRule));
  const [errors, setErrors] = useState<string[]>([]);

  // Scope picker state - seed from existing rule, fall back to first available server
  const [scopeMode, setScopeMode] = useState<ScopeMode>(initialScopeMode);
  const [scopeServerId, setScopeServerId] = useState<string>(
    initialRule?.serverId ?? servers[0]?.id ?? ''
  );
  const [scopeServerUserId, setScopeServerUserId] = useState<string>(
    initialRule?.serverUserId ?? ''
  );
  const [scopeUserId, setScopeUserId] = useState<string>(initialRule?.userId ?? '');
  const [enforceAcrossServers, setEnforceAcrossServers] = useState(
    initialRule?.enforceAcrossServers ?? false
  );

  const handleScopeServerChange = (serverId: string) => {
    setScopeServerId(serverId);
    setScopeServerUserId('');
  };

  // Fetch users for selected server when in user-scope mode
  const { data: usersPage } = useUsers(
    scopeMode === 'user' && scopeServerId ? { serverId: scopeServerId, pageSize: 100 } : {}
  );
  const userOptions = usersPage?.data ?? [];

  // Fetch the identity-deduped user list (one row per person, every server)
  // for person-scope mode - same list shape the merge account picker uses.
  const { data: identitiesPage } = useUsers(scopeMode === 'person' ? { pageSize: 100 } : {});
  const identityOptions = identitiesPage?.data ?? [];

  // The backend rejects mixing inactive_days with session fields, so the
  // field picker offers only the still-valid choices for the rule as built.
  const allowedFields = useMemo<ReadonlySet<string> | undefined>(() => {
    const compatible = INACTIVITY_COMPATIBLE_FIELDS as readonly string[];
    const fields = conditions.groups.flatMap((g) => g.conditions.map((c) => c.field));
    if (fields.includes('inactive_days')) return new Set(compatible);
    if (fields.some((f) => !compatible.includes(f))) {
      return new Set(Object.keys(FIELD_DEFINITIONS).filter((f) => f !== 'inactive_days'));
    }
    return undefined;
  }, [conditions]);

  // Cross-server enforcement is only meaningful for rules built from
  // identity-aware condition fields (see IDENTITY_AWARE_CONDITION_FIELDS),
  // and never for server-scoped rules: those detect on one server's sessions
  // only, and the backend rejects the combination.
  const canEnforceAcrossServers = useMemo(
    () =>
      scopeMode !== 'server' &&
      conditions.groups.some((group) =>
        group.conditions.some((c) =>
          (IDENTITY_AWARE_CONDITION_FIELDS as readonly string[]).includes(c.field)
        )
      ),
    [conditions, scopeMode]
  );

  // Validation
  const validate = (): boolean => {
    const newErrors: string[] = [];

    if (!name.trim()) {
      newErrors.push('Rule name is required');
    }

    if (conditions.groups.length === 0) {
      newErrors.push('At least one condition group is required');
    }

    for (const group of conditions.groups) {
      if (group.conditions.length === 0) {
        newErrors.push('Each condition group must have at least one condition');
      }
    }

    setErrors(newErrors);
    return newErrors.length === 0;
  };

  // Submit handler
  const handleSubmit = async () => {
    if (!validate()) return;

    // Exactly one of serverId, serverUserId, userId carries the chosen scope; the
    // other two stay null so the backend's mutual-exclusivity check passes.
    const data: CreateRuleV2Input | UpdateRuleV2Input = {
      name: name.trim(),
      description: description.trim() || null,
      severity,
      isActive,
      conditions,
      actions,
      serverId: scopeMode === 'server' && scopeServerId ? scopeServerId : null,
      serverUserId: scopeMode === 'user' && scopeServerUserId ? scopeServerUserId : null,
      userId: scopeMode === 'person' && scopeUserId ? scopeUserId : null,
      enforceAcrossServers: canEnforceAcrossServers ? enforceAcrossServers : false,
    };

    await onSave(data);
  };

  // Condition group handlers
  const addConditionGroup = () => {
    setConditions({
      groups: [...conditions.groups, createDefaultConditionGroup()],
    });
  };

  const updateConditionGroup = (index: number, group: ConditionGroupType) => {
    const newGroups = [...conditions.groups];
    newGroups[index] = group;
    setConditions({ groups: newGroups });
  };

  const removeConditionGroup = (index: number) => {
    if (conditions.groups.length === 1) return; // Keep at least one group
    const newGroups = conditions.groups.filter((_, i) => i !== index);
    setConditions({ groups: newGroups });
  };

  // Action handlers
  const addAction = () => {
    setActions({
      actions: [...actions.actions, createDefaultRuleAction()],
    });
  };

  const updateAction = (index: number, action: Action) => {
    const newActions = [...actions.actions];
    newActions[index] = action;
    setActions({ actions: newActions });
  };

  const removeAction = (index: number) => {
    const newActions = actions.actions.filter((_, i) => i !== index);
    setActions({ actions: newActions });
  };

  return (
    <div className="space-y-6">
      {/* Errors */}
      {errors.length > 0 && (
        <div className="border-destructive/50 bg-destructive/5 rounded-lg border p-4">
          <p className="text-destructive font-medium">Please fix the following errors:</p>
          <ul className="text-destructive mt-2 list-inside list-disc text-sm">
            {errors.map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Name, Description, Severity, and Active Toggle */}
      <div className="grid items-end gap-4 sm:grid-cols-[1fr_1fr_auto_auto]">
        <div className="space-y-2">
          <Label htmlFor="rule-name">Rule Name *</Label>
          <Input
            id="rule-name"
            placeholder="e.g., Block excessive streams"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="rule-description">Description</Label>
          <Input
            id="rule-description"
            placeholder="Optional description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="rule-severity">Severity</Label>
          <Select value={severity} onValueChange={(v) => setSeverity(v as ViolationSeverity)}>
            <SelectTrigger id="rule-severity" className="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SEVERITY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Switch id="rule-active" checked={isActive} onCheckedChange={setIsActive} />
          <Label htmlFor="rule-active" className="text-sm">
            Active
          </Label>
        </div>
      </div>

      {/* Scope Picker */}
      <div className="space-y-3">
        <Label>Scope</Label>
        <div className="flex flex-wrap gap-2">
          {(['global', 'server', 'user', 'person'] as ScopeMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setScopeMode(mode)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                scopeMode === mode
                  ? 'bg-primary text-primary-foreground border-transparent'
                  : 'border-border text-muted-foreground hover:bg-muted'
              }`}
            >
              {mode === 'global'
                ? 'Global'
                : mode === 'server'
                  ? 'Specific server'
                  : mode === 'user'
                    ? 'Specific account'
                    : 'Person (all their servers)'}
            </button>
          ))}
        </div>

        {(scopeMode === 'server' || scopeMode === 'user') && servers.length > 0 && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="scope-server" className="text-xs">
                Server
              </Label>
              <Select value={scopeServerId} onValueChange={handleScopeServerChange}>
                <SelectTrigger id="scope-server" className="w-[200px]">
                  <SelectValue placeholder="Select server" />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="flex items-center gap-2">
                        <ServerBadge server={s} variant="compact" />
                        {s.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {scopeMode === 'user' && scopeServerId && (
              <div className="space-y-1.5">
                <Label htmlFor="scope-user" className="text-xs">
                  User
                </Label>
                <Select value={scopeServerUserId} onValueChange={setScopeServerUserId}>
                  <SelectTrigger id="scope-user" className="w-[200px]">
                    <SelectValue placeholder="Select user" />
                  </SelectTrigger>
                  <SelectContent>
                    {userOptions.map((u) => (
                      <SelectItem key={u.id} value={u.id}>
                        {u.identityName ?? u.username}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        )}

        {scopeMode === 'person' && (
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="scope-person" className="text-xs">
                Person
              </Label>
              <Select value={scopeUserId} onValueChange={setScopeUserId}>
                <SelectTrigger id="scope-person" className="w-[200px]">
                  <SelectValue placeholder="Select person" />
                </SelectTrigger>
                <SelectContent>
                  {identityOptions.map((u) => (
                    <SelectItem key={u.userId} value={u.userId}>
                      {u.identityName ?? u.username}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {canEnforceAcrossServers && (
          <div className="flex items-start gap-2 pt-1">
            <Switch
              id="enforce-across-servers"
              checked={enforceAcrossServers}
              onCheckedChange={setEnforceAcrossServers}
            />
            <div>
              <Label htmlFor="enforce-across-servers" className="text-sm">
                Enforce across servers
              </Label>
              <p className="text-muted-foreground text-xs">
                When on, this rule can act on a person&apos;s sessions on any of their servers, not
                just the one that triggered it. Off by default.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Conditions Section */}
      <div className="bg-muted/30 space-y-4 rounded-lg border p-4">
        <div className="flex items-center justify-between border-b pb-3">
          <div>
            <h3 className="text-base font-semibold">Conditions</h3>
            <p className="text-muted-foreground text-sm">
              Define when this rule should trigger. Groups are combined with{' '}
              <span className="font-bold">AND</span> logic.
            </p>
          </div>
        </div>

        <div className="space-y-4">
          {conditions.groups.map((group, index) => (
            <div key={index}>
              {index > 0 && (
                <div className="my-4 flex items-center gap-2">
                  <div className="bg-border h-px flex-1" />
                  <span className="text-muted-foreground bg-muted rounded-full px-3 py-1 text-sm font-bold">
                    AND
                  </span>
                  <div className="bg-border h-px flex-1" />
                </div>
              )}
              <ConditionGroup
                group={group}
                groupIndex={index}
                onChange={(g) => updateConditionGroup(index, g)}
                onRemove={() => removeConditionGroup(index)}
                showRemove={conditions.groups.length > 1}
                filterOptions={filterOptions}
                allowedFields={allowedFields}
              />
            </div>
          ))}
        </div>

        <Button type="button" variant="outline" onClick={addConditionGroup}>
          <Plus className="mr-2 h-4 w-4" />
          Add <span className="font-bold">AND</span> condition group
        </Button>
      </div>

      {/* Actions Section */}
      <div className="bg-muted/30 space-y-4 rounded-lg border p-4">
        <div className="border-b pb-3">
          <h3 className="text-base font-semibold">Additional Actions</h3>
          <p className="text-muted-foreground text-sm">
            Optional side-effects when conditions are met. A violation is always created
            automatically.
          </p>
        </div>

        {actions.actions.length > 0 && (
          <div className="space-y-3">
            {actions.actions.map((action, index) => (
              <ActionRow
                key={index}
                action={action}
                onChange={(a) => updateAction(index, a)}
                onRemove={() => removeAction(index)}
                showRemove
              />
            ))}
          </div>
        )}

        <Button type="button" variant="outline" onClick={addAction}>
          <Plus className="mr-2 h-4 w-4" />
          Add action
        </Button>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-3 border-t pt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleSubmit} disabled={isLoading}>
          {isLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            <>
              <Save className="mr-2 h-4 w-4" />
              {initialRule ? 'Update Rule' : 'Create Rule'}
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

export default RuleBuilder;
