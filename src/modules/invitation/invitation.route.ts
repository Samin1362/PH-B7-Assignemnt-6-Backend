import { Role } from '@prisma/client';
import { Router } from 'express';
import { auth } from '../../middlewares/auth';
import { validateRequest } from '../../middlewares/validateRequest';
import { InvitationController } from './invitation.controller';
import { InvitationValidation } from './invitation.validation';

/**
 * Nested under /assessments/:id/invitations. mergeParams lets this router read
 * the assessment id from the mount path.
 */
const assessmentScoped = Router({ mergeParams: true });

assessmentScoped.post(
  '/',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest(InvitationValidation.create),
  InvitationController.create,
);
assessmentScoped.get(
  '/',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest(InvitationValidation.list),
  InvitationController.listForAssessment,
);

/** Mounted at /invitations. */
const standalone = Router();

standalone.get(
  '/my',
  auth(Role.CANDIDATE),
  validateRequest(InvitationValidation.my),
  InvitationController.listMine,
);
standalone.patch(
  '/:id/revoke',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest(InvitationValidation.revoke),
  InvitationController.revoke,
);

export const AssessmentInvitationRoutes = assessmentScoped;
export const InvitationRoutes = standalone;
