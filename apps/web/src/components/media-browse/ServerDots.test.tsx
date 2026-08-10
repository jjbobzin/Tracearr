import { beforeAll, describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import { ServerDots } from './ServerDots';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

describe('ServerDots', () => {
  it('carries a combined aria-label naming every server', () => {
    const { container } = render(
      <ServerDots
        servers={[
          { serverId: 'srv-1', name: 'Plex', type: 'plex' },
          { serverId: 'srv-2', name: 'Jellyfin', type: 'jellyfin' },
        ]}
      />
    );

    const wrapper = container.querySelector('[aria-label]');
    expect(wrapper).toHaveAttribute('aria-label', 'On Plex and Jellyfin');
  });

  it('gives the wrapper an img role so assistive tech announces the label', () => {
    const { container } = render(
      <ServerDots servers={[{ serverId: 'srv-1', name: 'Plex', type: 'plex' }]} />
    );

    expect(container.querySelector('[aria-label]')).toHaveAttribute('role', 'img');
  });

  it('marks every dot as decorative (aria-hidden)', () => {
    const { container } = render(
      <ServerDots servers={[{ serverId: 'srv-1', name: 'Plex', type: 'plex' }]} />
    );

    const dots = container.querySelectorAll('[aria-hidden="true"]');
    expect(dots).toHaveLength(1);
  });

  it('renders nothing for an empty server list', () => {
    const { container } = render(<ServerDots servers={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('dedupes multiple entries for the same server into one dot', () => {
    const { container } = render(
      <ServerDots
        servers={[
          { serverId: 'srv-1', name: 'Plex', type: 'plex' },
          { serverId: 'srv-1', name: 'Plex', type: 'plex' },
        ]}
      />
    );

    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label]')).toHaveAttribute('aria-label', 'On Plex');
  });
});
