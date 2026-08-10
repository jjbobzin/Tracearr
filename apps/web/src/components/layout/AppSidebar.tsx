import { useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ChevronRight, ArrowUpCircle, BookOpen, Globe, Heart } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Logo } from '@/components/brand/Logo';
import { ServerSelector } from './ServerSelector';
import { navigation, isNavGroup, type NavItem, type NavGroup } from './nav-data';
import { UpdateDialog } from './UpdateDialog';
import { cn } from '@/lib/utils';
import { useVersion } from '@/hooks/queries';
import { useSocket } from '@/hooks/useSocket';

function NavMenuItem({ item }: { item: NavItem }) {
  const { setOpenMobile } = useSidebar();
  const { t } = useTranslation('nav');
  const location = useLocation();
  const isActive =
    item.href === '/'
      ? location.pathname === '/'
      : location.pathname === item.href || location.pathname.startsWith(item.href + '/');

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive}>
        <NavLink to={item.href} end={item.href === '/'} onClick={() => setOpenMobile(false)}>
          <item.icon className="size-4" />
          <span>{t(item.nameKey)}</span>
        </NavLink>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * Nudges the nav scroll area down just enough that `groupEl` clears the
 * fixed footer (reserved via scroll-pb-24 on the content region) - never
 * scrolls past what's needed, so a group opening near the bottom doesn't get
 * its own trigger/children left half-hidden behind the footer.
 */
function scrollGroupAboveFooter(groupEl: HTMLElement | null) {
  const container = groupEl?.closest<HTMLElement>('[data-sidebar="content"]');
  if (!groupEl || !container) return;
  const reserved = parseFloat(getComputedStyle(container).scrollPaddingBottom) || 0;
  const visibleBottom = container.getBoundingClientRect().bottom - reserved;
  const overflow = groupEl.getBoundingClientRect().bottom - visibleBottom;
  if (overflow <= 0) return;
  const scrollTop: number = container.scrollTop;
  const maxScrollTop: number = container.scrollHeight - container.clientHeight;
  container.scrollTop = Math.min(scrollTop + overflow, maxScrollTop);
}

function NavMenuGroup({ group }: { group: NavGroup }) {
  const location = useLocation();
  const { setOpenMobile } = useSidebar();
  const { t } = useTranslation('nav');
  const isActive = group.children.some((child) => location.pathname.startsWith(child.href));
  const groupRef = useRef<HTMLDivElement>(null);

  return (
    <Collapsible
      ref={groupRef}
      defaultOpen={isActive}
      className="group/collapsible"
      onOpenChange={(open) => {
        if (open) requestAnimationFrame(() => scrollGroupAboveFooter(groupRef.current));
      }}
    >
      <SidebarMenuItem>
        <CollapsibleTrigger asChild>
          <SidebarMenuButton className={cn(isActive && 'font-medium')}>
            <group.icon className="size-4" />
            <span>{t(group.nameKey)}</span>
            <ChevronRight className="ml-auto size-4 transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
          </SidebarMenuButton>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarMenuSub>
            {group.children.map((child) => {
              const isParentOfSiblings = group.children.some(
                (other) => other !== child && other.href.startsWith(child.href + '/')
              );
              const childIsActive = isParentOfSiblings
                ? location.pathname === child.href
                : location.pathname === child.href ||
                  location.pathname.startsWith(child.href + '/');
              return (
                <SidebarMenuSubItem key={child.href}>
                  <SidebarMenuSubButton asChild isActive={childIsActive}>
                    <NavLink to={child.href} onClick={() => setOpenMobile(false)}>
                      <child.icon className="size-4" />
                      <span>{t(child.nameKey)}</span>
                    </NavLink>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </CollapsibleContent>
      </SidebarMenuItem>
    </Collapsible>
  );
}

function VersionDisplay() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const { t } = useTranslation(['common', 'settings']);
  const { data: version, isLoading } = useVersion();
  const { serverConnectionStatuses } = useSocket();
  const navigate = useNavigate();

  const pluginUpdateAvailable = [...serverConnectionStatuses.values()].some(
    (s) => s.pluginUpdateAvailable
  );

  if (isLoading || !version) {
    return <div className="text-muted-foreground text-xs">{t('common:states.loading')}</div>;
  }

  const displayVersion = version.current.tag ?? `v${version.current.version}`;

  const getUpdateLabel = () => {
    if (!version.latest) return t('settings:update.title');
    if (version.current.isPrerelease && !version.latest.isPrerelease) {
      return t('settings:update.stableRelease');
    }
    if (version.current.isPrerelease && version.latest.isPrerelease) {
      return t('settings:update.betaUpdate');
    }
    return t('settings:update.title');
  };

  return (
    <>
      <div className="flex items-center justify-center gap-2">
        <span className="text-muted-foreground text-xs">
          {displayVersion}
          {version.current.isPrerelease && (
            <span className="text-muted-foreground/60 ml-1">({t('common:beta')})</span>
          )}
        </span>
        {version.updateAvailable && version.latest && (
          <Badge
            variant="secondary"
            className="h-5 cursor-pointer gap-1 bg-green-500/10 text-green-600 hover:bg-green-500/20 dark:text-green-400"
            onClick={() => setDialogOpen(true)}
          >
            <ArrowUpCircle className="h-3 w-3" />
            <span className="text-[10px]">{getUpdateLabel()}</span>
          </Badge>
        )}
        {pluginUpdateAvailable && (
          <Badge
            variant="secondary"
            className="h-5 cursor-pointer bg-amber-500/10 text-amber-600 hover:bg-amber-500/20 dark:text-amber-400"
            onClick={() => navigate('/settings/servers')}
            title={t('settings:servers.pluginUpdateAvailable')}
            aria-label={t('settings:servers.pluginUpdateAvailable')}
          >
            <ArrowUpCircle className="h-3 w-3" />
          </Badge>
        )}
      </div>

      {version.updateAvailable && version.latest && (
        <UpdateDialog open={dialogOpen} onOpenChange={setDialogOpen} version={version} />
      )}
    </>
  );
}

function DiscordIcon({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" />
    </svg>
  );
}

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

const externalLinks = [
  { name: 'Discord', href: 'https://discord.gg/a7n3sFd2Yw', icon: DiscordIcon },
  { name: 'Docs', href: 'https://docs.tracearr.com/', icon: BookOpen },
  { name: 'Website', href: 'https://tracearr.com', icon: Globe },
  { name: 'GitHub', href: 'https://github.com/connorgallopo/Tracearr', icon: GithubIcon },
  { name: 'Sponsor', href: 'https://github.com/sponsors/connorgallopo', icon: Heart },
];

function ExternalLinks() {
  return (
    <div className="flex flex-col items-center gap-3 pb-2">
      <div className="flex items-center gap-3">
        <TooltipProvider delayDuration={0}>
          {externalLinks.map((link) => (
            <Tooltip key={link.name}>
              <TooltipTrigger asChild>
                <a
                  href={link.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  <link.icon className="size-4" />
                </a>
              </TooltipTrigger>
              <TooltipContent side="top">
                <p>{link.name}</p>
              </TooltipContent>
            </Tooltip>
          ))}
        </TooltipProvider>
      </div>
      <div className="bg-border h-px w-12" />
    </div>
  );
}

export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeader className="border-b p-0">
        <div className="flex h-14 items-center px-4">
          <Logo size="md" />
        </div>
        <ServerSelector />
      </SidebarHeader>
      {/* scroll-pb reserves room for the fixed footer below so a browser-native
          scrollIntoView (e.g. clicking a collapsible trigger near the bottom)
          doesn't stop short and leave the last nav item hidden behind it. */}
      <SidebarContent className="scroll-pb-24">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navigation.map((entry) => {
                if (isNavGroup(entry)) {
                  return <NavMenuGroup key={entry.nameKey} group={entry} />;
                }
                return <NavMenuItem key={entry.href} item={entry} />;
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <ExternalLinks />
        <VersionDisplay />
      </SidebarFooter>
    </Sidebar>
  );
}
