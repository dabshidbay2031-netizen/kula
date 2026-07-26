'use client';

import { useMemo } from 'react';

/**
 * Shared pager for the admin tables and the store's Orders/Customers lists.
 *
 * Reuses the `.pagination` / `.page-btn` styles already used by the Explore
 * grid, so paged lists look the same everywhere.
 */
interface Props {
  page: number;
  totalPages: number;
  onPage: (n: number) => void;
  /** "1–25 of 214" summary; pass the values from usePagination. */
  from?: number;
  to?: number;
  total?: number;
  /** What's being counted, for the summary line. */
  label?: string;
}

export default function Pagination({ page, totalPages, onPage, from, to, total, label = 'items' }: Props) {
  // A compact window around the current page, with … for the gaps.
  const numbers = useMemo<(number | '…')[]>(() => {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const out: (number | '…')[] = [1];
    const lo = Math.max(2, page - 1);
    const hi = Math.min(totalPages - 1, page + 1);
    if (lo > 2) out.push('…');
    for (let i = lo; i <= hi; i++) out.push(i);
    if (hi < totalPages - 1) out.push('…');
    out.push(totalPages);
    return out;
  }, [page, totalPages]);

  if (totalPages <= 1) return null;

  const go = (n: number) => onPage(Math.min(Math.max(n, 1), totalPages));

  return (
    <div>
      {total != null && (
        <div style={{ textAlign: 'center', fontSize: '.75rem', color: 'var(--text-muted)', marginTop: 10 }}>
          {from}–{to} of {total} {label}
        </div>
      )}
      <nav className="pagination" aria-label={`${label} pages`}>
        <button className="page-btn" onClick={() => go(page - 1)} disabled={page === 1} aria-label="Previous page">
          ← Prev
        </button>
        {numbers.map((n, i) =>
          n === '…' ? (
            <span key={`gap-${i}`} className="page-gap">…</span>
          ) : (
            <button
              key={n}
              className={`page-btn${n === page ? ' active' : ''}`}
              onClick={() => go(n)}
              aria-current={n === page ? 'page' : undefined}
            >
              {n}
            </button>
          ),
        )}
        <button className="page-btn" onClick={() => go(page + 1)} disabled={page === totalPages} aria-label="Next page">
          Next →
        </button>
      </nav>
    </div>
  );
}
