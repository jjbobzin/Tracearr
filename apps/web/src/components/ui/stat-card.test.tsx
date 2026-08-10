import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatCard } from './stat-card';

describe('StatCard', () => {
  it('fills its grid cell height on the kpi variant, so tiles line up regardless of detail line', () => {
    render(<StatCard label="Hours watched" value="182h" variant="kpi" />);
    expect(screen.getByText('182h').closest('div.bg-card-raised')).toHaveClass('h-full');
  });

  it('does not add h-full to the default variant', () => {
    render(<StatCard label="Sessions" value="42" />);
    expect(screen.getByText('42').closest('div.bg-card')).not.toHaveClass('h-full');
  });
});
