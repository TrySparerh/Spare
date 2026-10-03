import { useEffect } from 'react';

/** Sets <title> and the meta description for a route, and restores both on leave. */
export function usePageMeta(title: string, description: string): void {
  useEffect(() => {
    const prevTitle = document.title;
    let meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const created = !meta;
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'description';
      document.head.appendChild(meta);
    }
    const prevDesc = meta.content;
    document.title = title;
    meta.content = description;
    return () => {
      document.title = prevTitle;
      if (created) meta?.remove();
      else if (meta) meta.content = prevDesc;
    };
  }, [title, description]);
}

/**
 * Asks crawlers not to index this route while it is mounted (the 404 page:
 * the SPA answers HTTP 200 for any path). index.html ships
 * `<meta name="robots" content="index, follow, …">`; that tag is switched to
 * "noindex" rather than joined by a second one, so a crawler reading the
 * first robots tag sees the right answer. Restored on leave.
 */
export function useNoIndex(): void {
  useEffect(() => {
    const tags = [...document.querySelectorAll<HTMLMetaElement>('meta[name="robots"]')];
    const created = tags.length === 0;
    if (created) {
      const meta = document.createElement('meta');
      meta.name = 'robots';
      document.head.appendChild(meta);
      tags.push(meta);
    }
    const previous = tags.map((m) => m.content);
    tags.forEach((m) => (m.content = 'noindex'));
    return () => {
      if (created) tags.forEach((m) => m.remove());
      else tags.forEach((m, i) => (m.content = previous[i]));
    };
  }, []);
}
