import { z } from 'zod';
import { ASSESSMENT_SORTABLE_FIELDS } from './assessment.constant';

const isoDate = z.union([z.iso.datetime({ offset: true }), z.iso.datetime()]);

const createBody = z
  .object({
    title: z
      .string({ error: 'Title is required' })
      .trim()
      .min(3, 'Title must be at least 3 characters')
      .max(200),
    description: z.string().trim().max(5000).nullish(),
    durationMinutes: z
      .number()
      .int('Duration must be a whole number of minutes')
      .min(5, 'An assessment must run for at least 5 minutes')
      .max(480, 'An assessment cannot exceed 8 hours')
      .default(60),
    passingScore: z
      .number()
      .int()
      .min(0, 'Passing score cannot be negative')
      .max(100, 'Passing score is a percentage and cannot exceed 100')
      .default(60),
    startsAt: isoDate.nullish(),
    endsAt: isoDate.nullish(),
  })
  .superRefine((data, ctx) => {
    if (data.startsAt && data.endsAt && new Date(data.endsAt) <= new Date(data.startsAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['endsAt'],
        message: 'endsAt must be after startsAt',
      });
    }
  });

const updateBody = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    description: z.string().trim().max(5000).nullish(),
    durationMinutes: z.number().int().min(5).max(480).optional(),
    passingScore: z.number().int().min(0).max(100).optional(),
    startsAt: isoDate.nullish(),
    endsAt: isoDate.nullish(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sortBy: z.enum(ASSESSMENT_SORTABLE_FIELDS).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  q: z.string().trim().max(200).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED']).optional(),
});

const statusBody = z.object({
  status: z.enum(['DRAFT', 'PUBLISHED', 'CLOSED', 'ARCHIVED'], {
    error: 'status must be DRAFT, PUBLISHED, CLOSED or ARCHIVED',
  }),
});

const attachBody = z.object({
  problems: z
    .array(
      z.object({
        problemId: z.uuid('Invalid problem id'),
        points: z.number().int().min(1).max(100).optional(),
        order: z.number().int().min(1).max(500).optional(),
      }),
    )
    .min(1, 'Provide at least one problem')
    .max(50, 'At most 50 problems can be attached at once'),
});

const idParams = z.object({ id: z.uuid('Invalid assessment id') });
const problemParams = z.object({
  id: z.uuid('Invalid assessment id'),
  problemId: z.uuid('Invalid problem id'),
});

export const AssessmentValidation = {
  create: { body: createBody },
  update: { body: updateBody, params: idParams },
  list: { query: listQuery },
  byId: { params: idParams },
  changeStatus: { body: statusBody, params: idParams },
  attachProblems: { body: attachBody, params: idParams },
  detachProblem: { params: problemParams },
};

export type CreateAssessmentInput = z.infer<typeof createBody>;
export type UpdateAssessmentInput = z.infer<typeof updateBody>;
export type ListAssessmentQuery = z.infer<typeof listQuery>;
export type AttachProblemsInput = z.infer<typeof attachBody>;
