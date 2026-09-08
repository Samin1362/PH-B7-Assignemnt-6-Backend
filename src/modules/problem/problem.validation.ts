import { z } from 'zod';
import { PROBLEM_SORTABLE_FIELDS } from './problem.constant';

const optionSchema = z.object({
  text: z.string().trim().min(1, 'Option text is required').max(500),
  isCorrect: z.boolean().default(false),
});

const testCaseSchema = z.object({
  input: z.string().max(10000),
  expectedOutput: z.string().max(10000),
  isHidden: z.boolean().default(false),
  weight: z.number().int().min(1, 'Weight must be at least 1').max(100).default(1),
});

const baseProblem = {
  title: z.string({ error: 'Title is required' }).trim().min(3, 'Title must be at least 3 characters').max(200),
  description: z
    .string({ error: 'Description is required' })
    .trim()
    .min(10, 'Description must be at least 10 characters')
    .max(20000),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).default('MEDIUM'),
  points: z.number().int().min(1, 'Points must be at least 1').max(100).default(10),
  tags: z.array(z.string().trim().min(1).max(40)).max(20, 'At most 20 tags').default([]),
  language: z.string().trim().max(40).nullish(),
  starterCode: z.string().max(20000).nullish(),
  isPublic: z.boolean().default(false),
};

/**
 * Each problem type carries a different payload, and mismatched combinations
 * are rejected rather than silently ignored — an MCQ with no correct answer is
 * unscoreable, and a coding problem with options is a data-entry mistake.
 */
const typeConsistency = (
  data: {
    type: string;
    options?: { isCorrect: boolean }[];
    testCases?: unknown[];
  },
  ctx: z.RefinementCtx,
): void => {
  if (data.type === 'MCQ') {
    const options = data.options ?? [];
    if (options.length < 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'An MCQ problem needs at least 2 options',
      });
    }
    const correct = options.filter((o) => o.isCorrect).length;
    if (options.length >= 2 && correct !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['options'],
        message: `Exactly one option must be marked correct (found ${correct})`,
      });
    }
    if (data.testCases?.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['testCases'],
        message: 'Test cases apply to CODING problems only',
      });
    }
  }

  if (data.type !== 'MCQ' && data.options?.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['options'],
      message: 'Options apply to MCQ problems only',
    });
  }

  if (data.type === 'WRITTEN' && data.testCases?.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['testCases'],
      message: 'Test cases apply to CODING problems only',
    });
  }
};

const createBody = z
  .object({
    ...baseProblem,
    type: z.enum(['CODING', 'MCQ', 'WRITTEN'], { error: 'type must be CODING, MCQ or WRITTEN' }),
    options: z.array(optionSchema).max(10, 'At most 10 options').optional(),
    testCases: z.array(testCaseSchema).max(50, 'At most 50 test cases').optional(),
  })
  .superRefine(typeConsistency);

/**
 * `type` is intentionally not updatable: switching it would orphan the options
 * or test cases already attached to the problem.
 */
const updateBody = z
  .object({
    title: baseProblem.title.optional(),
    description: baseProblem.description.optional(),
    difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
    points: z.number().int().min(1).max(100).optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    language: z.string().trim().max(40).nullish(),
    starterCode: z.string().max(20000).nullish(),
    isPublic: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

const listQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sortBy: z.enum(PROBLEM_SORTABLE_FIELDS).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  q: z.string().trim().max(200).optional(),
  type: z.enum(['CODING', 'MCQ', 'WRITTEN']).optional(),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  tags: z.string().max(300).optional(),
  isPublic: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
});

const idParams = z.object({ id: z.uuid('Invalid problem id') });

const testCaseParams = z.object({
  id: z.uuid('Invalid problem id'),
  testCaseId: z.uuid('Invalid test case id'),
});

export const ProblemValidation = {
  create: { body: createBody },
  update: { body: updateBody, params: idParams },
  list: { query: listQuery },
  byId: { params: idParams },
  addTestCases: { body: z.object({ testCases: z.array(testCaseSchema).min(1).max(50) }), params: idParams },
  removeTestCase: { params: testCaseParams },
};

export type CreateProblemInput = z.infer<typeof createBody>;
export type UpdateProblemInput = z.infer<typeof updateBody>;
export type ListProblemQuery = z.infer<typeof listQuery>;
