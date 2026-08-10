/**
 * Classic rule templates for V2 rule builder.
 *
 * When a user selects a "classic" rule type, these templates pre-fill
 * the V2 rule builder with appropriate conditions and a default action.
 */

import type {
  RuleType,
  RuleConditions,
  RuleActions,
  ViolationSeverity,
  Condition,
  ConditionGroup,
} from '@tracearr/shared';

export interface ClassicRuleTemplate {
  type: RuleType;
  label: string;
  description: string;
  defaultName: string;
  severity: ViolationSeverity;
  conditions: RuleConditions;
  actions: RuleActions;
}

/**
 * Build the groups array for a template. Groups AND together while conditions
 * inside a group OR, so the is_local_network filter must be its own group;
 * inside the main group it would satisfy the rule for every remote session.
 */
function buildConditionGroups(
  mainCondition: Condition,
  excludePrivateIps: boolean
): ConditionGroup[] {
  const groups: ConditionGroup[] = [{ conditions: [mainCondition] }];

  if (excludePrivateIps) {
    groups.push({
      conditions: [{ field: 'is_local_network', operator: 'eq', value: false }],
    });
  }

  return groups;
}

/**
 * Default actions for classic rules (empty — violations are auto-created from rule severity)
 */
const DEFAULT_ACTIONS: RuleActions = {
  actions: [],
};

/**
 * Generate V2 template for Impossible Travel rule
 *
 * By default, excludes same-device comparisons since VPN switches on the
 * same device aren't "impossible travel" - the physical device didn't move.
 */
export function createImpossibleTravelTemplate(
  maxSpeedKmh: number = 500,
  excludePrivateIps: boolean = false
): ClassicRuleTemplate {
  return {
    type: 'impossible_travel',
    label: 'Impossible Travel',
    description: 'Detect physically impossible travel between sessions',
    defaultName: 'Impossible Travel Detection',
    severity: 'warning',
    conditions: {
      groups: buildConditionGroups(
        {
          field: 'travel_speed_kmh',
          operator: 'gt',
          value: maxSpeedKmh,
          params: { exclude_same_device: true },
        },
        excludePrivateIps
      ),
    },
    actions: DEFAULT_ACTIONS,
  };
}

/**
 * Generate V2 template for Simultaneous Locations rule
 *
 * By default, excludes same-device comparisons since the same physical device
 * can only be in one location. Multiple sessions from one device are stale data.
 */
export function createSimultaneousLocationsTemplate(
  minDistanceKm: number = 100,
  excludePrivateIps: boolean = false
): ClassicRuleTemplate {
  return {
    type: 'simultaneous_locations',
    label: 'Simultaneous Locations',
    description: 'Detect concurrent sessions from distant locations',
    defaultName: 'Simultaneous Location Detection',
    severity: 'warning',
    conditions: {
      groups: buildConditionGroups(
        {
          field: 'active_session_distance_km',
          operator: 'gte',
          value: minDistanceKm,
          params: { exclude_same_device: true },
        },
        excludePrivateIps
      ),
    },
    actions: DEFAULT_ACTIONS,
  };
}

/**
 * Generate V2 template for Device Velocity rule
 */
export function createDeviceVelocityTemplate(
  maxIps: number = 5,
  windowHours: number = 24,
  excludePrivateIps: boolean = false
): ClassicRuleTemplate {
  return {
    type: 'device_velocity',
    label: 'Device Velocity',
    description: 'Detect excessive unique IPs in a time window',
    defaultName: 'Device Velocity Detection',
    severity: 'warning',
    conditions: {
      groups: buildConditionGroups(
        {
          field: 'unique_ips_in_window',
          operator: 'gt',
          value: maxIps,
          params: { window_hours: windowHours },
        },
        excludePrivateIps
      ),
    },
    actions: DEFAULT_ACTIONS,
  };
}

/**
 * Generate V2 template for Concurrent Streams rule
 *
 * By default, excludes same-device sessions since a single physical device
 * can only play one stream. Duplicate sessions from one device are stale data.
 */
export function createConcurrentStreamsTemplate(
  maxStreams: number = 3,
  excludePrivateIps: boolean = false
): ClassicRuleTemplate {
  return {
    type: 'concurrent_streams',
    label: 'Concurrent Streams',
    description: 'Limit simultaneous streams per user',
    defaultName: 'Concurrent Stream Limit',
    severity: 'warning',
    conditions: {
      groups: buildConditionGroups(
        {
          field: 'concurrent_streams',
          operator: 'gt',
          value: maxStreams,
          params: { exclude_same_device: true },
        },
        excludePrivateIps
      ),
    },
    actions: DEFAULT_ACTIONS,
  };
}

/**
 * Generate V2 template for Geo Restriction rule
 *
 * Always excludes local network sessions to match V1 behavior.
 * Local network IPs have geoCountry='Local Network' which would incorrectly
 * trigger allowlist rules (since 'Local Network' is not in the allowed countries).
 */
export function createGeoRestrictionTemplate(
  mode: 'blocklist' | 'allowlist' = 'blocklist',
  countries: string[] = []
): ClassicRuleTemplate {
  // blocklist = trigger when country IS IN the list (blocked countries)
  // allowlist = trigger when country IS NOT IN the list (only allow these countries)
  const operator = mode === 'blocklist' ? 'in' : 'not_in';

  return {
    type: 'geo_restriction',
    label: 'Geo Restriction',
    description:
      mode === 'blocklist'
        ? 'Block streaming from specific countries'
        : 'Only allow specific countries',
    defaultName: mode === 'blocklist' ? 'Country Block List' : 'Country Allow List',
    severity: 'warning',
    conditions: {
      groups: [
        { conditions: [{ field: 'country', operator, value: countries }] },
        // Own group so it ANDs with the country check - matches V1, where
        // local IPs are never blocked
        { conditions: [{ field: 'is_local_network', operator: 'eq', value: false }] },
      ],
    },
    actions: DEFAULT_ACTIONS,
  };
}

/**
 * Generate V2 template for Account Inactivity rule
 */
export function createAccountInactivityTemplate(
  inactivityValue: number = 30,
  inactivityUnit: 'days' | 'weeks' | 'months' = 'days'
): ClassicRuleTemplate {
  // Convert to days for the condition
  let days = inactivityValue;
  if (inactivityUnit === 'weeks') days = inactivityValue * 7;
  if (inactivityUnit === 'months') days = inactivityValue * 30;

  return {
    type: 'account_inactivity',
    label: 'Account Inactivity',
    description: 'Detect inactive accounts',
    defaultName: 'Account Inactivity Detection',
    severity: 'warning',
    conditions: {
      groups: [
        {
          conditions: [{ field: 'inactive_days', operator: 'gte', value: days }],
        },
      ],
    },
    actions: DEFAULT_ACTIONS,
  };
}

/**
 * Get default template for a classic rule type
 */
export function getClassicRuleTemplate(type: RuleType): ClassicRuleTemplate {
  switch (type) {
    case 'impossible_travel':
      return createImpossibleTravelTemplate();
    case 'simultaneous_locations':
      return createSimultaneousLocationsTemplate();
    case 'device_velocity':
      return createDeviceVelocityTemplate();
    case 'concurrent_streams':
      return createConcurrentStreamsTemplate();
    case 'geo_restriction':
      return createGeoRestrictionTemplate();
    case 'account_inactivity':
      return createAccountInactivityTemplate();
    default:
      return createConcurrentStreamsTemplate();
  }
}

/**
 * All available classic rule templates with their defaults
 */
export const CLASSIC_RULE_TEMPLATES: ClassicRuleTemplate[] = [
  createConcurrentStreamsTemplate(),
  createGeoRestrictionTemplate(),
  createImpossibleTravelTemplate(),
  createSimultaneousLocationsTemplate(),
  createDeviceVelocityTemplate(),
  createAccountInactivityTemplate(),
];
