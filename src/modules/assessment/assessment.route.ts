import { Role } from '@prisma/client';
import { Router } from 'express';
import { auth } from '../../middlewares/auth';
import { validateRequest } from '../../middlewares/validateRequest';
import { AssessmentController } from './assessment.controller';
import { AssessmentValidation } from './assessment.validation';

const router = Router();

// Candidates may read assessments they were invited to, so reads are open to
// all authenticated roles and narrowed per role inside the service.
router.get(
  '/',
  auth(),
  validateRequest(AssessmentValidation.list),
  AssessmentController.list,
);
router.get(
  '/:id',
  auth(),
  validateRequest(AssessmentValidation.byId),
  AssessmentController.getById,
);

// Everything below mutates, and belongs to the owning company or an admin.
router.post(
  '/',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest(AssessmentValidation.create),
  AssessmentController.create,
);
router.patch(
  '/:id',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest(AssessmentValidation.update),
  AssessmentController.update,
);
router.patch(
  '/:id/status',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest(AssessmentValidation.changeStatus),
  AssessmentController.changeStatus,
);
router.post(
  '/:id/problems',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest(AssessmentValidation.attachProblems),
  AssessmentController.attachProblems,
);
router.delete(
  '/:id/problems/:problemId',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest(AssessmentValidation.detachProblem),
  AssessmentController.detachProblem,
);
router.delete(
  '/:id',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest(AssessmentValidation.byId),
  AssessmentController.remove,
);

export const AssessmentRoutes = router;
