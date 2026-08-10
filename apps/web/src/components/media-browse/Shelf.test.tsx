import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { Shelf } from './Shelf';

describe('Shelf', () => {
  it('renders a labelled region with list semantics', () => {
    render(
      <Shelf id="recently-added" title="Recently added">
        <div key="a">A</div>
        <div key="b">B</div>
      </Shelf>
    );

    const region = screen.getByRole('region', { name: 'Recently added' });
    expect(region).toBeInTheDocument();

    const list = screen.getByRole('list');
    expect(list).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('uses the shared thin-scrollbar utility and scroll snapping', () => {
    render(
      <Shelf id="recently-added" title="Recently added">
        <div key="a">A</div>
      </Shelf>
    );

    const list = screen.getByRole('list');
    expect(list).toHaveClass('scrollbar-thin', 'snap-x', 'snap-proximity');
    expect(screen.getAllByRole('listitem')[0]).toHaveClass('snap-start');
  });

  it('gives the scroll row padding on both axes so overflow-x: auto does not clip rank numerals that bleed above or left of a card', () => {
    render(
      <Shelf id="most-watched" title="Most watched">
        <div key="a">A</div>
      </Shelf>
    );

    const list = screen.getByRole('list');
    expect(list).toHaveClass('overflow-x-auto', 'pt-3', 'pl-1.5', '-ml-1.5');
  });

  it('renders an optional caption beside the heading', () => {
    render(
      <Shelf id="recently-added" title="Recently added" caption="deduped across servers">
        <div key="a">A</div>
      </Shelf>
    );
    expect(screen.getByText('deduped across servers')).toBeInTheDocument();
  });

  it('omits the caption when not provided', () => {
    render(
      <Shelf id="recently-added" title="Recently added">
        <div key="a">A</div>
      </Shelf>
    );
    expect(screen.queryByText('deduped across servers')).not.toBeInTheDocument();
  });

  it('renders a view-all link when both viewAllHref and viewAllLabel are provided', () => {
    render(
      <MemoryRouter>
        <Shelf
          id="recently-added"
          title="Recently added"
          viewAllHref="/media/movies"
          viewAllLabel="View all"
        >
          <div key="a">A</div>
        </Shelf>
      </MemoryRouter>
    );
    const link = screen.getByRole('link', { name: /View all/ });
    expect(link).toHaveAttribute('href', '/media/movies');
  });

  it('omits the view-all link when viewAllHref or viewAllLabel is missing', () => {
    render(
      <MemoryRouter>
        <Shelf id="recently-added" title="Recently added" viewAllHref="/media/movies">
          <div key="a">A</div>
        </Shelf>
      </MemoryRouter>
    );
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
