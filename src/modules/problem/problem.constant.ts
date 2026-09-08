/** Columns the search term is matched against. */
export const PROBLEM_SEARCHABLE_FIELDS = ['title', 'description'] as const;

/** Whitelist for ?sortBy= — anything else falls back to createdAt. */
export const PROBLEM_SORTABLE_FIELDS = [
  'createdAt',
  'updatedAt',
  'title',
  'difficulty',
  'points',
] as const;
