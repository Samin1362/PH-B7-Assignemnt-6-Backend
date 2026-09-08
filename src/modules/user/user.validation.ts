import { z } from 'zod';

/**
 * Optional URL that can also be explicitly cleared. An empty string is
 * normalised to null so `""` and `null` do not become two different "empty"
 * states in the database.
 */
const optionalUrl = z
  .union([z.url('Provide a valid URL'), z.literal(''), z.null()])
  .optional()
  .transform((value) => (value === '' ? null : value));

const optionalText = (max: number) =>
  z
    .union([z.string().trim().max(max), z.null()])
    .optional()
    .transform((value) => (value === '' ? null : value));

const updateMeBody = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100).optional(),
    avatarUrl: optionalUrl,
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

const candidateProfileBody = z.object({
  headline: optionalText(150),
  bio: optionalText(2000),
  skills: z
    .array(z.string().trim().min(1).max(50))
    .max(50, 'At most 50 skills')
    .optional()
    .default([]),
  experienceYears: z
    .number()
    .int('Experience must be a whole number')
    .min(0, 'Experience cannot be negative')
    .max(60, 'Experience looks unrealistic')
    .optional()
    .default(0),
  githubUrl: optionalUrl,
  linkedinUrl: optionalUrl,
  resumeUrl: optionalUrl,
  location: optionalText(150),
});

const companyProfileBody = z.object({
  companyName: z
    .string({ error: 'Company name is required' })
    .trim()
    .min(2, 'Company name must be at least 2 characters')
    .max(150),
  website: optionalUrl,
  industry: optionalText(100),
  companySize: z
    .enum(['1-10', '11-50', '51-200', '201-500', '500+'], {
      message: 'companySize must be one of 1-10, 11-50, 51-200, 201-500, 500+',
    })
    .optional()
    .nullable(),
  description: optionalText(2000),
  logoUrl: optionalUrl,
});

export const UserValidation = {
  updateMe: { body: updateMeBody },
  candidateProfile: { body: candidateProfileBody },
  companyProfile: { body: companyProfileBody },
};

export type UpdateMeInput = z.infer<typeof updateMeBody>;
export type CandidateProfileInput = z.infer<typeof candidateProfileBody>;
export type CompanyProfileInput = z.infer<typeof companyProfileBody>;
