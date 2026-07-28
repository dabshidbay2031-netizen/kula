import { describe, it, expect } from 'vitest';
import { stockedCategories, CATEGORIES } from '@/lib/data';

/**
 * The POS chip row is built from this. A register showing all thirteen
 * categories gives a cashier ten chips that filter the grid to nothing.
 */
const p = (category: string) => ({ category });

describe('stockedCategories', () => {
  it('returns only the categories present in the products', () => {
    const got = stockedCategories([p('food'), p('food'), p('health')]);
    expect(got.map(c => c.id)).toEqual(['food', 'health']);
  });

  it('is empty for an empty shelf', () => {
    expect(stockedCategories([])).toEqual([]);
  });

  it('keeps the canonical CATEGORIES order, not first-seen order', () => {
    // 'books' is last in CATEGORIES and 'electronics' first, so a naive
    // implementation that walked the products would return them reversed.
    const got = stockedCategories([p('books'), p('electronics')]);
    expect(got.map(c => c.id)).toEqual(['electronics', 'books']);
  });

  it('drops ids that are not real categories instead of inventing chips', () => {
    // Imported/legacy rows can carry anything; a chip with no matching
    // category has no icon or name to render and filters to nothing.
    const got = stockedCategories([p('food'), p(''), p('not-a-category')]);
    expect(got.map(c => c.id)).toEqual(['food']);
  });

  it('never returns more than the catalogue defines', () => {
    const everything = CATEGORIES.map(c => p(c.id));
    expect(stockedCategories(everything)).toHaveLength(CATEGORIES.length);
  });

  it('deduplicates — one chip per category however many products share it', () => {
    const got = stockedCategories([p('food'), p('food'), p('food')]);
    expect(got).toHaveLength(1);
  });
});
