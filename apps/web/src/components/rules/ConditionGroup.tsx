import { Plus } from 'lucide-react';
import type {
  Condition,
  ConditionGroup as ConditionGroupType,
  RulesFilterOptions,
} from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { ConditionRow } from './ConditionRow';
import { getDefaultOperatorForField, getDefaultValueForField } from '@/lib/rules';

interface ConditionGroupProps {
  group: ConditionGroupType;
  groupIndex: number;
  onChange: (group: ConditionGroupType) => void;
  onRemove: () => void;
  showRemove?: boolean;
  filterOptions?: RulesFilterOptions;
  allowedFields?: ReadonlySet<string>;
}

export function ConditionGroup({
  group,
  groupIndex,
  onChange,
  onRemove,
  showRemove = true,
  filterOptions,
  allowedFields,
}: ConditionGroupProps) {
  // Add a new condition to the group
  const addCondition = () => {
    const defaultField = 'concurrent_streams';
    const newCondition: Condition = {
      field: defaultField,
      operator: getDefaultOperatorForField(defaultField),
      value: getDefaultValueForField(defaultField),
    };
    onChange({
      conditions: [...group.conditions, newCondition],
    });
  };

  // Update a condition
  const updateCondition = (index: number, condition: Condition) => {
    const newConditions = [...group.conditions];
    newConditions[index] = condition;
    onChange({ conditions: newConditions });
  };

  // Remove a condition
  const removeCondition = (index: number) => {
    if (group.conditions.length === 1) {
      // If last condition, remove the entire group
      onRemove();
    } else {
      const newConditions = group.conditions.filter((_, i) => i !== index);
      onChange({ conditions: newConditions });
    }
  };

  return (
    <div className="border-border bg-card rounded-lg border p-4">
      {/* Group Header */}
      <div className="mb-3 flex items-center justify-between">
        <span className="text-muted-foreground text-sm font-medium">
          Group {groupIndex + 1}
          <span className="ml-2 text-xs opacity-60">
            (conditions match with <span className="font-bold">OR</span> logic)
          </span>
        </span>
        {showRemove && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onRemove}
          >
            Remove group
          </Button>
        )}
      </div>

      {/* Conditions */}
      <div className="space-y-2">
        {group.conditions.map((condition, index) => (
          <div key={index}>
            {index > 0 && (
              <div className="my-2 flex items-center gap-2">
                <div className="bg-border h-px flex-1" />
                <span className="text-primary px-2 text-xs font-bold">OR</span>
                <div className="bg-border h-px flex-1" />
              </div>
            )}
            <ConditionRow
              condition={condition}
              onChange={(c) => updateCondition(index, c)}
              onRemove={() => removeCondition(index)}
              showRemove={group.conditions.length > 1}
              filterOptions={filterOptions}
              allowedFields={allowedFields}
            />
          </div>
        ))}
      </div>

      {/* Add Condition Button */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="text-muted-foreground mt-3"
        onClick={addCondition}
      >
        <Plus className="mr-1 h-4 w-4" />
        Add <span className="font-bold">OR</span> condition
      </Button>
    </div>
  );
}

export default ConditionGroup;
