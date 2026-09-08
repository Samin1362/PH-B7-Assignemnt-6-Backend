import { z } from 'zod';

const startBody = z.object({
  token: z.string({ error: 'An invitation token is required' }).trim().min(16, 'Invalid token'),
});

/**
 * One payload covers all three problem types; which fields are meaningful is
 * decided by the problem's own type at save time, so a candidate cannot smuggle
 * an MCQ option onto a written answer.
 */
const answerBody = z.object({
  problemId: z.uuid('Invalid problem id'),
  selectedOptionId: z.uuid('Invalid option id').nullish(),
  code: z.string().max(50000, 'Code is too long').nullish(),
  language: z.string().trim().max(40).nullish(),
  output: z.string().max(20000, 'Output is too long').nullish(),
  answerText: z.string().max(50000, 'Answer is too long').nullish(),
});

const evaluateBody = z.object({
  score: z.number().min(0, 'Score cannot be negative'),
  feedback: z.string().trim().max(5000).nullish(),
});

const myQuery = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sortBy: z.enum(['createdAt', 'submittedAt', 'totalScore', 'status']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['IN_PROGRESS', 'SUBMITTED', 'EVALUATED', 'EXPIRED']).optional(),
});

const assessmentAttemptsQuery = myQuery.extend({
  passed: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
  q: z.string().trim().max(200).optional(),
});

export const AttemptValidation = {
  start: { body: startBody },
  answer: { body: answerBody, params: z.object({ id: z.uuid('Invalid attempt id') }) },
  byId: { params: z.object({ id: z.uuid('Invalid attempt id') }) },
  my: { query: myQuery },
  forAssessment: {
    query: assessmentAttemptsQuery,
    params: z.object({ id: z.uuid('Invalid assessment id') }),
  },
  evaluate: { body: evaluateBody, params: z.object({ id: z.uuid('Invalid submission id') }) },
};

export type StartInput = z.infer<typeof startBody>;
export type AnswerInput = z.infer<typeof answerBody>;
export type EvaluateInput = z.infer<typeof evaluateBody>;
export type MyAttemptQuery = z.infer<typeof myQuery>;
export type AssessmentAttemptQuery = z.infer<typeof assessmentAttemptsQuery>;
