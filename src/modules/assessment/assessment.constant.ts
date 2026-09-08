import { AssessmentStatus } from '@prisma/client';

export const ASSESSMENT_SEARCHABLE_FIELDS = ['title', 'description'] as const;

export const ASSESSMENT_SORTABLE_FIELDS = [
  'createdAt',
  'updatedAt',
  'title',
  'status',
  'durationMinutes',
  'publishedAt',
] as const;

/**
 * The only legal moves. Anything absent from this map is rejected with 409 and
 * the allowed set, rather than being silently applied.
 *
 * DRAFT can be abandoned straight to ARCHIVED; a PUBLISHED assessment must be
 * CLOSED before it can be archived, so an assessment can never skip past the
 * point where candidates were still able to attempt it. ARCHIVED is terminal.
 */
export const ALLOWED_TRANSITIONS: Record<AssessmentStatus, AssessmentStatus[]> = {
  DRAFT: [AssessmentStatus.PUBLISHED, AssessmentStatus.ARCHIVED],
  PUBLISHED: [AssessmentStatus.CLOSED],
  CLOSED: [AssessmentStatus.ARCHIVED],
  ARCHIVED: [],
};

/**
 * Which fields may still be edited in each state.
 *
 * Once PUBLISHED, duration and passing score are frozen: candidates may already
 * have attempts in flight, and changing either would retroactively alter how
 * their work is scored. Presentation fields stay editable so a typo can be
 * fixed without closing the assessment.
 */
export const EDITABLE_FIELDS: Record<AssessmentStatus, string[]> = {
  DRAFT: ['title', 'description', 'durationMinutes', 'passingScore', 'startsAt', 'endsAt'],
  PUBLISHED: ['title', 'description', 'endsAt'],
  CLOSED: [],
  ARCHIVED: [],
};
