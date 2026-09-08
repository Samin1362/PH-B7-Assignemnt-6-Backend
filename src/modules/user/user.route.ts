import { Role } from '@prisma/client';
import { Router } from 'express';
import { auth } from '../../middlewares/auth';
import { validateRequest } from '../../middlewares/validateRequest';
import { UserController } from './user.controller';
import { UserValidation } from './user.validation';

const router = Router();

router.get('/me', auth(), UserController.getMe);
router.patch('/me', auth(), validateRequest(UserValidation.updateMe), UserController.updateMe);
router.get('/me/profile', auth(), UserController.getMyProfile);

// Each profile table is writable only by the role that owns it.
router.put(
  '/me/candidate-profile',
  auth(Role.CANDIDATE),
  validateRequest(UserValidation.candidateProfile),
  UserController.updateCandidateProfile,
);
router.put(
  '/me/company-profile',
  auth(Role.COMPANY),
  validateRequest(UserValidation.companyProfile),
  UserController.updateCompanyProfile,
);

export const UserRoutes = router;
