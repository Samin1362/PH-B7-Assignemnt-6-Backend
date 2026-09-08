import { Role } from '@prisma/client';
import { Router } from 'express';
import { auth } from '../../middlewares/auth';
import { validateRequest } from '../../middlewares/validateRequest';
import { AttemptController } from './attempt.controller';
import { AttemptValidation } from './attempt.validation';

const router = Router();

// `/my` is declared before `/:id` so it is not swallowed by the id route.
router.get('/my', auth(Role.CANDIDATE), validateRequest(AttemptValidation.my), AttemptController.listMine);

router.post(
  '/start',
  auth(Role.CANDIDATE),
  validateRequest(AttemptValidation.start),
  AttemptController.start,
);
router.post(
  '/:id/answers',
  auth(Role.CANDIDATE),
  validateRequest(AttemptValidation.answer),
  AttemptController.saveAnswer,
);
router.post(
  '/:id/submit',
  auth(Role.CANDIDATE),
  validateRequest(AttemptValidation.byId),
  AttemptController.submit,
);
// Readable by the candidate who owns it and by the assessment's company.
router.get('/:id', auth(), validateRequest(AttemptValidation.byId), AttemptController.getById);

export const AttemptRoutes = router;

/** Nested under /assessments/:id/attempts. */
const assessmentScoped = Router({ mergeParams: true });
assessmentScoped.get(
  '/',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest(AttemptValidation.forAssessment),
  AttemptController.listForAssessment,
);
export const AssessmentAttemptRoutes = assessmentScoped;

/** Mounted at /submissions. */
const submissionRouter = Router();
submissionRouter.patch(
  '/:id/evaluate',
  auth(Role.COMPANY, Role.ADMIN),
  validateRequest(AttemptValidation.evaluate),
  AttemptController.evaluate,
);
export const SubmissionRoutes = submissionRouter;
