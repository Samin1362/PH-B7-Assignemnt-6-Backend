import { Role } from '@prisma/client';
import { Router } from 'express';
import { auth } from '../../middlewares/auth';
import { validateRequest } from '../../middlewares/validateRequest';
import { ProblemController } from './problem.controller';
import { ProblemValidation } from './problem.validation';

const router = Router();

// Candidates never reach the problem bank — it holds answer keys and hidden
// test cases. They receive problems through the attempt endpoints instead.
router.use(auth(Role.COMPANY, Role.ADMIN));

router.post('/', validateRequest(ProblemValidation.create), ProblemController.create);
router.get('/', validateRequest(ProblemValidation.list), ProblemController.list);
router.get('/:id', validateRequest(ProblemValidation.byId), ProblemController.getById);
router.patch('/:id', validateRequest(ProblemValidation.update), ProblemController.update);
router.delete('/:id', validateRequest(ProblemValidation.byId), ProblemController.remove);

router.post(
  '/:id/test-cases',
  validateRequest(ProblemValidation.addTestCases),
  ProblemController.addTestCases,
);
router.delete(
  '/:id/test-cases/:testCaseId',
  validateRequest(ProblemValidation.removeTestCase),
  ProblemController.removeTestCase,
);

export const ProblemRoutes = router;
