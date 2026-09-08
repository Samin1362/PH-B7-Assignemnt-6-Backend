import { Router } from 'express';
import { auth } from '../../middlewares/auth';
import { validateRequest } from '../../middlewares/validateRequest';
import { AuthController } from './auth.controller';
import { AuthValidation } from './auth.validation';

const router = Router();

router.post('/register', validateRequest(AuthValidation.register), AuthController.register);
router.post('/login', validateRequest(AuthValidation.login), AuthController.login);
router.post('/google', validateRequest(AuthValidation.google), AuthController.googleLogin);
router.post('/refresh-token', validateRequest(AuthValidation.refresh), AuthController.refreshToken);
router.post('/logout', auth(), AuthController.logout);
router.post(
  '/change-password',
  auth(),
  validateRequest(AuthValidation.changePassword),
  AuthController.changePassword,
);

export const AuthRoutes = router;
