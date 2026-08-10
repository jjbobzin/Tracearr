import { useQuery } from '@tanstack/react-query';
import { Loader2, Clock, CheckCircle2, AlertCircle, Activity } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import { useSocket } from '@/hooks/useSocket';
import { api } from '@/lib/api';
import type { RunningTask } from '@tracearr/shared';
import { formatDistanceToNow } from 'date-fns';

function TaskIcon({ status }: { status: RunningTask['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="text-primary h-4 w-4 animate-spin" />;
    case 'waiting':
      return <Clock className="text-muted-foreground h-4 w-4 animate-pulse" />;
    case 'pending':
      return <Clock className="text-muted-foreground h-4 w-4" />;
    case 'complete':
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case 'error':
      return <AlertCircle className="text-destructive h-4 w-4" />;
    default:
      return <Clock className="text-muted-foreground h-4 w-4" />;
  }
}

function TaskItem({ task }: { task: RunningTask }) {
  const startedAt = new Date(task.startedAt);
  const timeAgo = formatDistanceToNow(startedAt, { addSuffix: true });

  const getBadgeContent = () => {
    switch (task.status) {
      case 'running':
        return 'Running';
      case 'waiting':
        return 'Waiting';
      default:
        return 'Queued';
    }
  };

  return (
    <div className="space-y-2 px-2 py-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5">
          <TaskIcon status={task.status} />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{task.name}</span>
            <Badge
              variant={task.status === 'running' ? 'default' : 'secondary'}
              className="shrink-0 text-xs"
            >
              {getBadgeContent()}
            </Badge>
          </div>
          {task.context && <p className="text-muted-foreground truncate text-xs">{task.context}</p>}
          <p className="text-muted-foreground text-xs">{task.message}</p>
          {task.progress !== null && task.status === 'running' && (
            <Progress value={task.progress} className="h-1.5" />
          )}
          <p className="text-muted-foreground/70 text-xs">Started {timeAgo}</p>
        </div>
      </div>
    </div>
  );
}

export function RunningTasksDropdown() {
  const { isConnected } = useSocket();

  // With the socket connected, job progress events invalidate this cache in
  // SocketProvider; polling backstops queued jobs that have not emitted a
  // progress event yet, so the connected interval stays reasonably tight.
  const { data, isLoading } = useQuery({
    queryKey: ['tasks', 'running'],
    queryFn: () => api.tasks.getRunning(),
    refetchInterval: isConnected ? 15_000 : 10_000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });

  const tasks = data?.tasks ?? [];

  // Filter to show only active tasks (running, waiting, or pending)
  const activeTasks = tasks.filter(
    (t) => t.status === 'running' || t.status === 'waiting' || t.status === 'pending'
  );
  const runningTasks = activeTasks.filter((t) => t.status === 'running');
  const waitingTasks = activeTasks.filter((t) => t.status === 'waiting');
  const queuedTasks = activeTasks.filter((t) => t.status === 'pending');

  // Don't render anything if no active tasks
  if (isLoading || activeTasks.length === 0) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative">
          <Loader2 className="h-4 w-4 animate-spin" />
          {activeTasks.length > 0 && (
            <span className="bg-primary text-primary-foreground absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-medium">
              {activeTasks.length}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel className="flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Running Tasks
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {runningTasks.length > 0 && (
          <>
            {runningTasks.map((task) => (
              <TaskItem key={task.id} task={task} />
            ))}
          </>
        )}

        {waitingTasks.length > 0 && (
          <>
            {runningTasks.length > 0 && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Waiting
            </DropdownMenuLabel>
            {waitingTasks.map((task) => (
              <TaskItem key={task.id} task={task} />
            ))}
          </>
        )}

        {queuedTasks.length > 0 && (
          <>
            {(runningTasks.length > 0 || waitingTasks.length > 0) && <DropdownMenuSeparator />}
            <DropdownMenuLabel className="text-muted-foreground text-xs font-normal">
              Queued
            </DropdownMenuLabel>
            {queuedTasks.map((task) => (
              <TaskItem key={task.id} task={task} />
            ))}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
