import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { CatalogLetterBucket } from '@tracearr/shared';
import { AlphabetScrubber } from './AlphabetScrubber';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

describe('AlphabetScrubber roving keyboard behavior', () => {
  it('renders one tab stop for the whole rail', () => {
    render(<AlphabetScrubber activeLetter={null} onJump={vi.fn()} />);
    const listbox = screen.getByRole('listbox');
    expect(listbox).toHaveAttribute('tabindex', '0');
    const options = screen.getAllByRole('option');
    for (const option of options) {
      expect(option).not.toHaveAttribute('tabindex');
    }
  });

  it('moves aria-activedescendant with ArrowDown without jumping', async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<AlphabetScrubber activeLetter={null} onJump={onJump} />);
    const listbox = screen.getByRole('listbox');
    listbox.focus();
    expect(listbox).toHaveAttribute('aria-activedescendant', 'alpha-scrubber-opt-0');

    await user.keyboard('{ArrowDown}');
    expect(listbox).toHaveAttribute('aria-activedescendant', 'alpha-scrubber-opt-1');
    expect(onJump).not.toHaveBeenCalled();
  });

  it('jumps to the focused letter on Enter', async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<AlphabetScrubber activeLetter={null} onJump={onJump} />);
    const listbox = screen.getByRole('listbox');
    listbox.focus();

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    // index 0 is '#', index 1 is 'A', index 2 is 'B'
    expect(onJump).toHaveBeenCalledWith('B');
  });

  it('clamps ArrowUp at the first letter', async () => {
    const user = userEvent.setup();
    render(<AlphabetScrubber activeLetter={null} onJump={vi.fn()} />);
    const listbox = screen.getByRole('listbox');
    listbox.focus();

    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(listbox).toHaveAttribute('aria-activedescendant', 'alpha-scrubber-opt-0');
  });

  it('marks the active letter with aria-current', () => {
    render(<AlphabetScrubber activeLetter="C" onJump={vi.fn()} />);
    const active = screen.getByText('C');
    expect(active).toHaveAttribute('aria-current', 'true');
  });

  it('only shows the focus ring once the rail actually has focus', async () => {
    const user = userEvent.setup();
    render(<AlphabetScrubber activeLetter={null} onJump={vi.fn()} />);
    const listbox = screen.getByRole('listbox');
    const firstOption = screen.getByText('#');
    expect(firstOption.className).not.toContain('ring-1');

    await act(() => listbox.focus());
    expect(firstOption.className).toContain('ring-1');

    await user.keyboard('{Tab}');
    expect(firstOption.className).not.toContain('ring-1');
  });

  it('renders as a Select on the "select" variant', () => {
    render(<AlphabetScrubber activeLetter={null} onJump={vi.fn()} variant="select" />);
    expect(screen.getByRole('combobox')).toBeInTheDocument();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('announces the active letter to assistive tech via an aria-live region', () => {
    const { rerender } = render(<AlphabetScrubber activeLetter={null} onJump={vi.fn()} />);
    const listbox = screen.getByRole('listbox');
    const liveRegion = listbox.querySelector('[aria-live="polite"]')!;
    expect(liveRegion.textContent).toBe('');

    rerender(<AlphabetScrubber activeLetter="F" onJump={vi.fn()} />);
    expect(liveRegion.textContent).toContain('"letter":"F"');
  });
});

describe('empty-letter dimming', () => {
  function lettersWith(nonEmpty: string[]): CatalogLetterBucket[] {
    return ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')].map((letter) => ({
      letter,
      count: nonEmpty.includes(letter) ? 3 : 0,
    }));
  }

  it('ignores clicks on a zero-count letter', async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<AlphabetScrubber activeLetter={null} onJump={onJump} letters={lettersWith(['A'])} />);
    await user.click(screen.getByText('B'));
    expect(onJump).not.toHaveBeenCalled();
    await user.click(screen.getByText('A'));
    expect(onJump).toHaveBeenCalledWith('A');
  });

  it('marks zero-count letters aria-disabled and skips them on Enter', async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<AlphabetScrubber activeLetter={null} onJump={onJump} letters={lettersWith(['A'])} />);
    expect(screen.getByText('B')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('A')).not.toHaveAttribute('aria-disabled');

    const listbox = screen.getByRole('listbox');
    listbox.focus();
    // Focus '#' (index 0, empty) and press Enter: no jump.
    await user.keyboard('{Enter}');
    expect(onJump).not.toHaveBeenCalled();
  });

  it('treats all letters as enabled while counts have not loaded', async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<AlphabetScrubber activeLetter={null} onJump={onJump} />);
    await user.click(screen.getByText('Q'));
    expect(onJump).toHaveBeenCalledWith('Q');
  });
});
