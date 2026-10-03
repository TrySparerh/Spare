import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The public shell's live chain line is not under test here.
vi.mock('wagmi', () => ({ usePublicClient: () => undefined }));

import NotFound from './NotFound';

const robots = () => [...document.head.querySelectorAll<HTMLMetaElement>('meta[name="robots"]')].map((m) => m.content);

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[path]}>
        <NotFound />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
  vi.stubGlobal('scrollTo', () => undefined);
  // What index.html ships.
  const meta = document.createElement('meta');
  meta.name = 'robots';
  meta.content = 'index, follow, max-image-preview:large';
  document.head.appendChild(meta);
});

afterEach(() => {
  cleanup();
  document.head.querySelectorAll('meta[name="robots"]').forEach((m) => m.remove());
  vi.unstubAllGlobals();
});

describe('404 page', () => {
  it('tells crawlers noindex — the only robots answer on the page — and restores it on leave', () => {
    const { unmount } = renderAt('/nonexistent-xyz');
    expect(screen.getByText('/nonexistent-xyz')).toBeInTheDocument();
    expect(robots()).toEqual(['noindex']);
    unmount();
    expect(robots()).toEqual(['index, follow, max-image-preview:large']);
  });

  it('adds the tag when the page has none, and removes it on leave', () => {
    document.head.querySelectorAll('meta[name="robots"]').forEach((m) => m.remove());
    const { unmount } = renderAt('/nope');
    expect(robots()).toEqual(['noindex']);
    unmount();
    expect(robots()).toEqual([]);
  });
});
