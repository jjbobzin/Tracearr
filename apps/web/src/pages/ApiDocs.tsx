/**
 * API documentation page rendered with Scalar.
 * The spec endpoints require the public API key, so the document is fetched
 * here with the user's token and handed to Scalar as content; the same token
 * is preset on the bearer scheme so "Test request" works immediately.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import { BASE_PATH } from '@/lib/basePath';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useTheme } from '@/components/theme-provider';
import { useApiKey } from '@/hooks/queries/useSettings';
import './ApiDocs.css';

// Get the API base URL for fetching the OpenAPI spec
const API_BASE = import.meta.env.VITE_API_URL || BASE_PATH;

type ApiVersion = 'v1' | 'v2';

export function ApiDocs() {
  const { t } = useTranslation('pages');
  const { data: apiKeyData, isLoading } = useApiKey();
  const token = apiKeyData?.token;
  const { theme } = useTheme();
  const [apiVersion, setApiVersion] = useState<ApiVersion>('v2');
  const [spec, setSpec] = useState<Record<string, unknown> | null>(null);
  const [specError, setSpecError] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setSpec(null);
    setSpecError(false);
    // Deliberately not the api client: /public/docs authenticates with the
    // public bearer token, not the dashboard cookie session
    fetch(`${API_BASE}/api/${apiVersion}/public/docs`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`spec fetch failed: ${res.status}`);
        return res.json() as Promise<Record<string, unknown>>;
      })
      .then((doc) => {
        if (!cancelled) setSpec(doc);
      })
      .catch(() => {
        if (!cancelled) setSpecError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token, apiVersion]);

  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const configuration = useMemo(
    () => ({
      content: spec ?? undefined,
      darkMode: isDark,
      hideDarkModeToggle: true,
      hideClientButton: true,
      authentication: token
        ? {
            preferredSecurityScheme: 'bearerAuth',
            securitySchemes: {
              bearerAuth: { token },
            },
          }
        : undefined,
    }),
    [spec, token, isDark]
  );

  // Show loading while fetching API key
  if (isLoading) {
    return (
      <div className="api-docs-wrapper flex items-center justify-center">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="api-docs-wrapper">
      <div className="api-docs-header flex flex-wrap items-center gap-2">
        <Link to="/settings">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            {t('apiDocs.backToSettings')}
          </Button>
        </Link>
        {token && (
          <span className="text-muted-foreground text-sm">{t('apiDocs.apiKeyAutoLoaded')}</span>
        )}
        {!token && <span className="text-sm text-yellow-500">{t('apiDocs.noApiKey')}</span>}
        <div
          role="group"
          aria-label={t('apiDocs.versionSwitcherLabel')}
          className="ml-auto flex gap-1.5"
        >
          {(['v1', 'v2'] as const).map((version) => (
            <Button
              key={version}
              type="button"
              variant={apiVersion === version ? 'default' : 'outline'}
              size="sm"
              aria-pressed={apiVersion === version}
              onClick={() => setApiVersion(version)}
              className={cn(
                apiVersion === version && 'ring-primary ring-offset-background ring-1 ring-offset-1'
              )}
            >
              {t(`apiDocs.version${version === 'v1' ? 'V1' : 'V2'}`)}
            </Button>
          ))}
        </div>
      </div>
      {specError && (
        <div className="text-destructive flex h-48 items-center justify-center text-sm">
          {t('apiDocs.specLoadError')}
        </div>
      )}
      {!specError && !spec && token && (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
        </div>
      )}
      {!specError && spec && <ApiReferenceReact key={apiVersion} configuration={configuration} />}
    </div>
  );
}
