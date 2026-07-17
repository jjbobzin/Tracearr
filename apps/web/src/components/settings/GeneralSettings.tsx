/**
 * General settings section - appearance, application settings, network, and API key.
 */
import { useState } from 'react';
import { Link as RouterLink } from 'react-router';
import { getData, getName } from 'country-list';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Field, FieldGroup, FieldLabel, FieldDescription, FieldError } from '@/components/ui/field';
import {
  AutosaveNumberField,
  AutosaveSelectField,
  AutosaveSwitchField,
  AutosaveTextField,
  SaveStatusIndicator,
} from '@/components/ui/autosave-field';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  RefreshCw,
  ExternalLink,
  Loader2,
  Copy,
  Globe,
  AlertTriangle,
  KeyRound,
  LocateFixed,
  Sun,
  Moon,
  Monitor,
  Check,
  RotateCcw,
  Palette,
  Settings as SettingsIcon,
  Languages,
  Clock,
  ChevronsUpDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useTheme, ACCENT_PRESETS } from '@/components/theme-provider';
import { useDebouncedSave, TEXT_INPUT_DELAY } from '@/hooks/useDebouncedSave';
import { useSettings, useApiKey, useRegenerateApiKey } from '@/hooks/queries';
import {
  languageNames,
  getCurrentLanguage,
  changeLanguage,
  useTranslation,
} from '@tracearr/translations';
import { getTimeFormat, setTimeFormat, type TimeFormat } from '@/lib/timeFormat';

type ThemeMode = 'light' | 'dark' | 'system';

const DEFAULT_THEME: ThemeMode = 'dark';
const DEFAULT_HUE = 187; // Cyan

const THEME_MODES = [
  { value: 'light' as const, labelKey: 'general.themeLight' as const, icon: Sun },
  { value: 'dark' as const, labelKey: 'general.themeDark' as const, icon: Moon, isDefault: true },
  { value: 'system' as const, labelKey: 'general.themeSystem' as const, icon: Monitor },
];

const COUNTRY_OPTIONS = getData();

function ApiKeyCard() {
  const { t } = useTranslation(['settings', 'common', 'notifications']);
  const { data: apiKeyData, isLoading } = useApiKey();
  const regenerateApiKey = useRegenerateApiKey();
  const [showConfirm, setShowConfirm] = useState(false);

  const token = apiKeyData?.token;
  const hasKey = !!token;

  const handleCopy = async () => {
    if (token) {
      try {
        await navigator.clipboard.writeText(token);
        toast.success(t('notifications:toast.success.copiedToClipboard.title'));
      } catch {
        toast.error(t('notifications:toast.error.copyFailed'));
      }
    }
  };

  const handleRegenerate = () => {
    if (hasKey) {
      setShowConfirm(true);
    } else {
      regenerateApiKey.mutate();
    }
  };

  const confirmRegenerate = () => {
    regenerateApiKey.mutate();
    setShowConfirm(false);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="h-5 w-5" />
                {t('common:labels.apiKey')}
              </CardTitle>
              <CardDescription>{t('general.apiKeyDesc')}</CardDescription>
            </div>
            <RouterLink to="/api-docs">
              <Button variant="outline" size="sm" className="gap-1.5">
                <ExternalLink className="h-3.5 w-3.5" />
                {t('general.apiDocs')}
              </Button>
            </RouterLink>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={token ?? ''}
                  placeholder={t('general.noApiKeyGenerated')}
                  className="font-mono text-sm"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                  disabled={!hasKey}
                  title={t('general.copyToClipboard')}
                >
                  <Copy className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex items-center justify-between">
                <p className="text-muted-foreground text-sm">
                  {hasKey ? t('general.apiKeyReadAccess') : t('general.generateApiKeyPrompt')}
                </p>
                <Button
                  variant={hasKey ? 'outline' : 'default'}
                  size="sm"
                  onClick={handleRegenerate}
                  disabled={regenerateApiKey.isPending}
                >
                  {regenerateApiKey.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-2 h-4 w-4" />
                  )}
                  {hasKey ? t('general.regenerate') : t('general.generateKey')}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        title={t('general.regenerateApiKey')}
        description={t('general.regenerateApiKeyDesc')}
        confirmLabel={t('general.regenerate')}
        onConfirm={confirmRegenerate}
      />
    </>
  );
}

/**
 * Language selector field with localStorage persistence.
 */
function LanguageField() {
  const { t } = useTranslation('settings');
  const [language, setLanguage] = useState(getCurrentLanguage);

  const handleLanguageChange = (lang: string) => {
    setLanguage(lang);
    void changeLanguage(lang);
  };

  return (
    <Field>
      <FieldLabel htmlFor="language" className="flex items-center gap-2">
        <Languages className="h-4 w-4" />
        {t('general.language')}
      </FieldLabel>
      <Select value={language} onValueChange={handleLanguageChange}>
        <SelectTrigger id="language" className="w-full max-w-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Object.entries(languageNames).map(([code, name]) => (
            <SelectItem key={code} value={code}>
              {name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <FieldDescription>
        {t('general.languageDescription')}{' '}
        <a
          href="https://crowdin.com/project/tracearr"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1"
        >
          {t('general.helpTranslate')}
          <ExternalLink className="h-3 w-3" />
        </a>
      </FieldDescription>
    </Field>
  );
}

/**
 * Time format selector field with localStorage persistence.
 */
function TimeFormatField() {
  const { t } = useTranslation('settings');
  const [timeFormat, setTimeFormatState] = useState<TimeFormat>(getTimeFormat);

  const handleTimeFormatChange = (value: string) => {
    const tf = value as TimeFormat;
    setTimeFormatState(tf);
    setTimeFormat(tf);
  };

  return (
    <Field>
      <FieldLabel htmlFor="timeFormat" className="flex items-center gap-2">
        <Clock className="h-4 w-4" />
        {t('general.timeFormat')}
      </FieldLabel>
      <Select value={timeFormat} onValueChange={handleTimeFormatChange}>
        <SelectTrigger id="timeFormat" className="w-full max-w-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="12h">{t('general.timeFormat12h')}</SelectItem>
          <SelectItem value="24h">{t('general.timeFormat24h')}</SelectItem>
        </SelectContent>
      </Select>
      <FieldDescription>{t('general.timeFormatDescription')}</FieldDescription>
    </Field>
  );
}

interface LocalCountrySelectProps {
  value: string | null | undefined;
  onChange: (country: { code: string | null; name: string | null }) => void;
  placeholder: string;
  searchPlaceholder: string;
  emptyMessage: string;
}

function LocalCountrySelect({
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyMessage,
}: LocalCountrySelectProps) {
  const [open, setOpen] = useState(false);
  const selectedName = value ? (getName(value) ?? value) : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-10 w-full justify-between"
        >
          <span className={cn(!selectedName && 'text-muted-foreground')}>
            {selectedName ?? placeholder}
          </span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-0" align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyMessage}</CommandEmpty>
            <CommandGroup>
              {value && (
                <CommandItem
                  value="clear-country"
                  onSelect={() => {
                    onChange({ code: null, name: null });
                    setOpen(false);
                  }}
                >
                  <span className="text-muted-foreground">{placeholder}</span>
                </CommandItem>
              )}
              {COUNTRY_OPTIONS.map((country) => (
                <CommandItem
                  key={country.code}
                  value={`${country.name} ${country.code}`}
                  onSelect={() => {
                    onChange({ code: country.code, name: country.name });
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      'mr-2 h-4 w-4',
                      value === country.code ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span className="flex-1">{country.name}</span>
                  <span className="text-muted-foreground ml-2 text-xs">{country.code}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function GeneralSettings() {
  const { t } = useTranslation(['settings', 'common']);
  const { data: settings, isLoading } = useSettings();
  const { theme, setTheme, accentHue, setAccentHue } = useTheme();
  const [isLocatingBrowser, setIsLocatingBrowser] = useState(false);

  // General settings fields
  const unitSystemField = useDebouncedSave('unitSystem', settings?.unitSystem);
  const pollerEnabledField = useDebouncedSave('pollerEnabled', settings?.pollerEnabled);
  const pollerIntervalField = useDebouncedSave('pollerIntervalMs', settings?.pollerIntervalMs, {
    delay: TEXT_INPUT_DELAY,
    transform: (ms) => Math.max(5000, Math.min(300000, ms)),
  });
  const usePlexGeoipField = useDebouncedSave('usePlexGeoip', settings?.usePlexGeoip);
  const localLocationNameField = useDebouncedSave(
    'localLocationName',
    settings?.localLocationName,
    { delay: TEXT_INPUT_DELAY }
  );
  const localCityField = useDebouncedSave('localCity', settings?.localCity, {
    delay: TEXT_INPUT_DELAY,
  });
  const localRegionField = useDebouncedSave('localRegion', settings?.localRegion, {
    delay: TEXT_INPUT_DELAY,
  });
  const localCountryField = useDebouncedSave('localCountry', settings?.localCountry, {
    delay: TEXT_INPUT_DELAY,
  });
  const localCountryCodeField = useDebouncedSave(
    'localCountryCode',
    settings?.localCountryCode,
    { delay: TEXT_INPUT_DELAY }
  );
  const localLatitudeField = useDebouncedSave('localLatitude', settings?.localLatitude, {
    delay: TEXT_INPUT_DELAY,
  });
  const localLongitudeField = useDebouncedSave('localLongitude', settings?.localLongitude, {
    delay: TEXT_INPUT_DELAY,
  });

  // Network settings fields
  const externalUrlField = useDebouncedSave('externalUrl', settings?.externalUrl, {
    delay: TEXT_INPUT_DELAY,
  });
  const intervalSeconds = Math.round((pollerIntervalField.value ?? 15000) / 1000);

  const handleIntervalChange = (seconds: number) => {
    pollerIntervalField.setValue(seconds * 1000);
  };

  const handleLocalCountryChange = (country: { code: string | null; name: string | null }) => {
    localCountryField.setValue(country.name);
    localCountryCodeField.setValue(country.code);
    setTimeout(() => {
      localCountryField.saveNow();
      localCountryCodeField.saveNow();
    }, 0);
  };

  const handleUseBrowserLocation = () => {
    if (!window.isSecureContext) {
      toast.error(t('general.localBrowserLocationRequiresSecureContext'));
      return;
    }

    if (!navigator.geolocation) {
      toast.error(t('general.localBrowserLocationUnavailable'));
      return;
    }

    setIsLocatingBrowser(true);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const latitude = Number(position.coords.latitude.toFixed(2));
        const longitude = Number(position.coords.longitude.toFixed(2));

        localLatitudeField.setValue(latitude);
        localLongitudeField.setValue(longitude);
        setTimeout(() => {
          localLatitudeField.saveNow();
          localLongitudeField.saveNow();
        }, 0);
        setIsLocatingBrowser(false);
        toast.success(t('general.localBrowserLocationSaved'));
      },
      () => {
        setIsLocatingBrowser(false);
        toast.error(t('general.localBrowserLocationFailed'));
      },
      {
        enableHighAccuracy: false,
        maximumAge: 300000,
        timeout: 10000,
      }
    );
  };

  const handleDetectUrl = () => {
    let detectedUrl = window.location.origin;
    if (import.meta.env.DEV) {
      detectedUrl = detectedUrl.replace(':5173', ':3000');
    }
    externalUrlField.setValue(detectedUrl);
    setTimeout(() => externalUrlField.saveNow(), 0);
  };

  const externalUrl = externalUrlField.value ?? '';
  const isLocalhost = externalUrl.includes('localhost') || externalUrl.includes('127.0.0.1');
  const isHttp = externalUrl.startsWith('http://') && !isLocalhost;

  const isDefaultTheme = theme === DEFAULT_THEME && accentHue === DEFAULT_HUE;

  const handleThemeReset = () => {
    setTheme(DEFAULT_THEME);
    setAccentHue(DEFAULT_HUE);
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-64" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Appearance */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <Palette className="h-5 w-5" />
                {t('general.appearance')}
              </CardTitle>
              <CardDescription>{t('general.appearanceDesc')}</CardDescription>
            </div>
            {!isDefaultTheme && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleThemeReset}
                className="text-muted-foreground hover:text-foreground gap-1.5"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('common:actions.reset')}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Mode Selection */}
          <div className="space-y-2">
            <label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t('general.theme')}
            </label>
            <div className="flex gap-2">
              {THEME_MODES.map(({ value, labelKey, icon: Icon, isDefault: isDefaultMode }) => (
                <Button
                  key={value}
                  variant={theme === value ? 'default' : 'outline'}
                  size="sm"
                  className={cn(
                    'flex-1 gap-1.5',
                    theme === value && 'ring-primary ring-offset-background ring-1 ring-offset-1'
                  )}
                  onClick={() => setTheme(value)}
                >
                  <Icon className="h-4 w-4" />
                  <span>{t(labelKey)}</span>
                  {isDefaultMode && (
                    <span className="text-[10px] opacity-60">{t('general.default')}</span>
                  )}
                </Button>
              ))}
            </div>
          </div>

          {/* Accent Color Selection */}
          <div className="space-y-2">
            <label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {t('general.accentColor')}
            </label>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
              {ACCENT_PRESETS.map((preset) => {
                const isSelected = accentHue === preset.hue;
                const isDefaultColor = preset.hue === DEFAULT_HUE;
                return (
                  <button
                    key={preset.hue}
                    onClick={() => setAccentHue(preset.hue)}
                    className={cn(
                      'group relative flex flex-col items-center gap-1 rounded-lg p-1.5 transition-all',
                      'hover:bg-muted/50 focus:ring-primary focus:ring-offset-background focus:ring-2 focus:ring-offset-2 focus:outline-none'
                    )}
                    title={preset.name}
                  >
                    <div
                      className={cn(
                        'relative h-8 w-8 rounded-md transition-transform',
                        'group-hover:scale-105',
                        isSelected && 'ring-offset-background scale-105 ring-2 ring-offset-2'
                      )}
                      style={{
                        backgroundColor: preset.hex,
                        ['--tw-ring-color' as string]: isSelected ? preset.hex : undefined,
                      }}
                    >
                      {isSelected && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Check className="h-4 w-4 text-white drop-shadow-md" />
                        </div>
                      )}
                    </div>
                    <span
                      className={cn(
                        'text-[10px] leading-tight',
                        isSelected ? 'text-foreground font-medium' : 'text-muted-foreground'
                      )}
                    >
                      {preset.name}
                      {isDefaultColor && !isSelected && <span className="opacity-60">*</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-muted-foreground text-[10px]">{t('general.cyanDefault')}</p>
          </div>
        </CardContent>
      </Card>

      {/* Application Settings */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <SettingsIcon className="h-5 w-5" />
            {t('general.application')}
          </CardTitle>
          <CardDescription>{t('general.applicationDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <AutosaveSelectField
              id="unitSystem"
              label={t('general.unitSystem')}
              description={t('general.unitSystemDesc')}
              value={unitSystemField.value ?? 'metric'}
              onChange={(v) => unitSystemField.setValue(v as 'metric' | 'imperial')}
              options={[
                { value: 'metric', label: t('general.metric') },
                { value: 'imperial', label: t('general.imperial') },
              ]}
              status={unitSystemField.status}
              errorMessage={unitSystemField.errorMessage}
              onRetry={unitSystemField.retry}
              onReset={unitSystemField.reset}
            />

            <LanguageField />

            <TimeFormatField />

            <AutosaveSwitchField
              id="pollerEnabled"
              label={t('general.sessionSync')}
              description={t('general.sessionSyncDesc')}
              checked={pollerEnabledField.value ?? true}
              onChange={(v) => pollerEnabledField.setValue(v)}
              status={pollerEnabledField.status}
              errorMessage={pollerEnabledField.errorMessage}
              onRetry={pollerEnabledField.retry}
              onReset={pollerEnabledField.reset}
            />

            <AutosaveNumberField
              id="pollerIntervalMs"
              label={t('general.syncInterval')}
              description={t('general.syncIntervalDesc')}
              value={intervalSeconds}
              onChange={handleIntervalChange}
              min={5}
              max={300}
              suffix={t('general.syncIntervalSuffix')}
              disabled={!(pollerEnabledField.value ?? true)}
              status={pollerIntervalField.status}
              errorMessage={pollerIntervalField.errorMessage}
              onRetry={pollerIntervalField.retry}
              onReset={pollerIntervalField.reset}
            />

            <div className="bg-muted/50 space-y-2 rounded-lg p-4">
              <p className="text-muted-foreground text-sm">
                <strong>Plex:</strong> {t('general.plexSseNote')}
              </p>
              <p className="text-muted-foreground text-sm">
                <strong>Jellyfin/Emby:</strong> {t('general.jellyfinPollingNote')}
              </p>
            </div>

            <AutosaveSwitchField
              id="usePlexGeoip"
              label={t('general.enhancedGeoIP')}
              description={t('general.enhancedGeoIPDesc')}
              checked={usePlexGeoipField.value ?? false}
              onChange={(v) => usePlexGeoipField.setValue(v)}
              status={usePlexGeoipField.status}
              errorMessage={usePlexGeoipField.errorMessage}
              onRetry={usePlexGeoipField.retry}
              onReset={usePlexGeoipField.reset}
            />

            <div className="space-y-4 rounded-lg border p-4">
              <div>
                <h3 className="text-sm font-medium">{t('general.localLocation')}</h3>
                <p className="text-muted-foreground text-sm">
                  {t('general.localLocationDesc')}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit gap-2"
                onClick={handleUseBrowserLocation}
                disabled={isLocatingBrowser}
              >
                {isLocatingBrowser ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LocateFixed className="h-4 w-4" />
                )}
                {t('general.localUseBrowserLocation')}
              </Button>

              <div className="grid gap-4 md:grid-cols-2">
                <AutosaveTextField
                  id="localLocationName"
                  label={t('general.localLocationName')}
                  description={t('general.localLocationNameDesc')}
                  value={localLocationNameField.value ?? ''}
                  onChange={(v) => localLocationNameField.setValue(v)}
                  placeholder={t('general.localLocationNamePlaceholder')}
                  maxLength={255}
                  status={localLocationNameField.status}
                  errorMessage={localLocationNameField.errorMessage}
                  onRetry={localLocationNameField.retry}
                  onReset={localLocationNameField.reset}
                />
                <AutosaveTextField
                  id="localCity"
                  label={t('general.localCity')}
                  value={localCityField.value ?? ''}
                  onChange={(v) => localCityField.setValue(v)}
                  placeholder={t('general.localCityPlaceholder')}
                  maxLength={255}
                  status={localCityField.status}
                  errorMessage={localCityField.errorMessage}
                  onRetry={localCityField.retry}
                  onReset={localCityField.reset}
                />
                <AutosaveTextField
                  id="localRegion"
                  label={t('general.localRegion')}
                  value={localRegionField.value ?? ''}
                  onChange={(v) => localRegionField.setValue(v)}
                  placeholder={t('general.localRegionPlaceholder')}
                  maxLength={255}
                  status={localRegionField.status}
                  errorMessage={localRegionField.errorMessage}
                  onRetry={localRegionField.retry}
                  onReset={localRegionField.reset}
                />
                <Field
                  data-invalid={
                    localCountryField.status === 'error' ||
                    localCountryCodeField.status === 'error'
                  }
                >
                  <div className="flex items-center justify-between">
                    <FieldLabel>{t('general.localCountry')}</FieldLabel>
                    <SaveStatusIndicator
                      status={
                        localCountryField.status === 'error'
                          ? localCountryField.status
                          : localCountryCodeField.status
                      }
                    />
                  </div>
                  <LocalCountrySelect
                    value={localCountryCodeField.value}
                    onChange={handleLocalCountryChange}
                    placeholder={t('general.localCountryPlaceholder')}
                    searchPlaceholder={t('general.localCountrySearchPlaceholder')}
                    emptyMessage={t('general.localCountryEmpty')}
                  />
                  <FieldDescription>{t('general.localCountryDesc')}</FieldDescription>
                  {localCountryField.status === 'error' && localCountryField.errorMessage && (
                    <FieldError>{localCountryField.errorMessage}</FieldError>
                  )}
                  {localCountryCodeField.status === 'error' &&
                    localCountryCodeField.errorMessage && (
                      <FieldError>{localCountryCodeField.errorMessage}</FieldError>
                    )}
                </Field>
                <Field
                  data-invalid={
                    localLatitudeField.status === 'error' ||
                    localLongitudeField.status === 'error'
                  }
                >
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <FieldLabel htmlFor="localLatitude">
                          {t('general.localLatitude')}
                        </FieldLabel>
                        <SaveStatusIndicator status={localLatitudeField.status} />
                      </div>
                      <Input
                        id="localLatitude"
                        type="number"
                        inputMode="decimal"
                        min={-90}
                        max={90}
                        step="any"
                        value={localLatitudeField.value ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value;
                          localLatitudeField.setValue(raw === '' ? null : Number(raw));
                        }}
                        placeholder={t('general.localLatitudePlaceholder')}
                        aria-invalid={localLatitudeField.status === 'error'}
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <FieldLabel htmlFor="localLongitude">
                          {t('general.localLongitude')}
                        </FieldLabel>
                        <SaveStatusIndicator status={localLongitudeField.status} />
                      </div>
                      <Input
                        id="localLongitude"
                        type="number"
                        inputMode="decimal"
                        min={-180}
                        max={180}
                        step="any"
                        value={localLongitudeField.value ?? ''}
                        onChange={(e) => {
                          const raw = e.target.value;
                          localLongitudeField.setValue(raw === '' ? null : Number(raw));
                        }}
                        placeholder={t('general.localLongitudePlaceholder')}
                        aria-invalid={localLongitudeField.status === 'error'}
                      />
                    </div>
                  </div>
                  <FieldDescription>{t('general.localCoordinatesDesc')}</FieldDescription>
                  {(localLatitudeField.status === 'error' && localLatitudeField.errorMessage) ||
                  (localLongitudeField.status === 'error' && localLongitudeField.errorMessage) ? (
                    <div className="space-y-1">
                      {localLatitudeField.status === 'error' && localLatitudeField.errorMessage && (
                        <FieldError>{localLatitudeField.errorMessage}</FieldError>
                      )}
                      {localLongitudeField.status === 'error' &&
                        localLongitudeField.errorMessage && (
                          <FieldError>{localLongitudeField.errorMessage}</FieldError>
                        )}
                    </div>
                  ) : null}
                </Field>
              </div>
            </div>
          </FieldGroup>
        </CardContent>
      </Card>

      {/* Network / External Access */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            {t('general.externalAccess')}
          </CardTitle>
          <CardDescription>{t('general.externalAccessDesc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            <Field>
              <div className="flex items-center justify-between">
                <FieldLabel htmlFor="externalUrl">{t('general.externalUrl')}</FieldLabel>
                <SaveStatusIndicator status={externalUrlField.status} />
              </div>
              <div className="flex gap-2">
                <Input
                  id="externalUrl"
                  placeholder={t('general.externalUrlPlaceholder')}
                  value={externalUrlField.value ?? ''}
                  onChange={(e) => externalUrlField.setValue(e.target.value)}
                  aria-invalid={externalUrlField.status === 'error'}
                />
                <Button variant="outline" onClick={handleDetectUrl}>
                  {t('general.detect')}
                </Button>
              </div>
              <FieldDescription>{t('general.externalUrlDesc')}</FieldDescription>
              {externalUrlField.status === 'error' && externalUrlField.errorMessage && (
                <div className="flex items-center justify-between">
                  <FieldError>{externalUrlField.errorMessage}</FieldError>
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={externalUrlField.retry}
                      className="h-6 px-2 text-xs"
                    >
                      {t('common:actions.retry')}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={externalUrlField.reset}
                      className="h-6 px-2 text-xs"
                    >
                      {t('common:actions.reset')}
                    </Button>
                  </div>
                </div>
              )}
              {isLocalhost && (
                <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 p-3 text-sm text-yellow-600 dark:text-yellow-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t('general.localhostWarning')}</span>
                </div>
              )}
              {isHttp && (
                <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 p-3 text-sm text-yellow-600 dark:text-yellow-400">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{t('general.iosHttpWarning')}</span>
                </div>
              )}
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>

      {/* API Key */}
      <ApiKeyCard />
    </div>
  );
}
