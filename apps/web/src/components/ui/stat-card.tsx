/**
 * Reusable stat card component for displaying metrics.
 * Used on Dashboard and History pages.
 */

import type { LucideIcon } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Link } from 'react-router';
import { cn } from '@/lib/utils';

interface StatCardProps {
  icon?: LucideIcon;
  label: string;
  value: string | number;
  subValue?: string;
  isLoading?: boolean;
  href?: string;
  /**
   * 'kpi' is the media detail unit's iconless, raised-surface treatment
   * (uppercase label, larger value, sub-value on its own line). Default is
   * unchanged - it's shared with Dashboard/History. The kpi variant's h-full
   * only applies to the card div itself - when href is set, the <Link>
   * wrapper around it has no h-full, so a linked kpi tile would collapse to
   * content height inside an equal-height grid row. No caller passes href
   * with kpi today.
   */
  variant?: 'default' | 'kpi';
}

export function StatCard({
  icon: Icon,
  label,
  value,
  subValue,
  isLoading,
  href,
  variant = 'default',
}: StatCardProps) {
  const card =
    variant === 'kpi' ? (
      <div className="bg-card-raised h-full rounded-[calc(var(--radius)+2px)] border p-[14px_16px]">
        {isLoading ? (
          <>
            <Skeleton className="h-6 w-16" />
            <Skeleton className="mt-2 h-3 w-20" />
          </>
        ) : (
          <>
            <div className="text-[22px] font-bold tracking-[-0.02em] tabular-nums">{value}</div>
            <div className="text-muted-foreground mt-0.5 text-[11px] font-semibold tracking-[0.06em] uppercase">
              {label}
            </div>
            {subValue && <div className="text-muted-foreground mt-1 text-[11px]">{subValue}</div>}
          </>
        )}
      </div>
    ) : (
      <div
        className={cn(
          'bg-card flex items-center gap-3 rounded-lg border p-3',
          href && 'card-hover'
        )}
      >
        {Icon && (
          <div className="bg-primary/10 flex h-9 w-9 shrink-0 items-center justify-center rounded-md">
            <Icon className="text-primary h-4 w-4" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          {isLoading ? (
            <>
              <Skeleton className="h-5 w-16" />
              <Skeleton className="mt-1 h-3 w-12" />
            </>
          ) : (
            <>
              <div className="text-lg font-semibold tabular-nums">{value}</div>
              <div className="text-muted-foreground text-xs">
                {label}
                {subValue && <span className="ml-1">({subValue})</span>}
              </div>
            </>
          )}
        </div>
      </div>
    );

  return href ? (
    <Link
      to={href}
      className="group focus-visible:ring-ring focus-visible:ring-offset-background block rounded-lg focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      {card}
    </Link>
  ) : (
    card
  );
}

// Format duration in human readable format
export function formatWatchTime(ms: number): string {
  if (!ms) return '0m';
  const totalMinutes = Math.floor(ms / 60000);
  const minutes = totalMinutes % 60;
  const hours = Math.floor(totalMinutes / 60);
  const remainingHours = hours % 24;
  const days = Math.floor(hours / 24);
  const remainingDays = days % 365;
  const years = Math.floor(days / 365);

  if (years > 0) {
    return `${years}yr ${remainingDays}d ${remainingHours}h`;
  }
  if (days > 0) {
    return `${days}d ${remainingHours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// Format large numbers with commas
export function formatNumber(n: number): string {
  return n.toLocaleString();
}
