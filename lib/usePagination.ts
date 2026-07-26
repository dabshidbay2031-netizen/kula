'use client';

import { useEffect, useMemo, useState } from 'react';

/**
 * Client-side pagination for an already-loaded list.
 *
 * Used by the admin tables and the store's Orders/Customers lists, which all
 * render everything at once today. Extracted so those six lists behave
 * identically rather than each growing its own slightly different version.
 *
 * `resetKey` should carry whatever the caller filters/searches by: when it
 * changes the view jumps back to page 1, otherwise a filter that shrinks the
 * list strands the user on a page that no longer exists.
 */
export function usePagination<T>(items: T[], pageSize = 25, resetKey = '') {
  const [page, setPage] = useState(1);

  useEffect(() => { setPage(1); }, [resetKey]);

  const totalPages = Math.max(Math.ceil(items.length / pageSize), 1);
  // Clamp rather than reset: deleting the last row of the final page should
  // step back a page, not throw the user to the start.
  const safePage   = Math.min(page, totalPages);
  const start      = (safePage - 1) * pageSize;

  const visible = useMemo(
    () => items.slice(start, start + pageSize),
    [items, start, pageSize],
  );

  return {
    visible,
    page: safePage,
    totalPages,
    /** 1-based index of the first item shown (0 when the list is empty). */
    from: items.length === 0 ? 0 : start + 1,
    /** 1-based index of the last item shown. */
    to: Math.min(start + pageSize, items.length),
    total: items.length,
    setPage,
    /** True when the list fits on one page — callers hide the controls. */
    single: totalPages <= 1,
  };
}
