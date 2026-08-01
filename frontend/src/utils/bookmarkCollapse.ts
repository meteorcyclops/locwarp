export const isDefaultBookmarkCategory = (name: string): boolean =>
  name === '預設' || name.toLowerCase() === 'default';

export function initialBookmarkCollapseState(
  categories: string[],
  savedExpanded: string[] | null,
  overThreshold: boolean,
): Record<string, boolean> {
  const saved = savedExpanded === null ? null : new Set(savedExpanded);
  return Object.fromEntries(categories.map((category) => {
    if (isDefaultBookmarkCategory(category)) return [category, false];
    if (saved !== null) return [category, !saved.has(category)];
    return [category, overThreshold];
  }));
}

