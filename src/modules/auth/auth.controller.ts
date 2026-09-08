import { StatusCodes } from 'http-status-codes';
import { ApiError } from '../../utils/ApiError';
import { requestContext } from '../../utils/audit';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/sendResponse';
import { AuthService } from './auth.service';

/** Refresh tokens travel in a body field or an httpOnly cookie. */
const readRefreshToken = (req: {
  body?: { refreshToken?: string };
  cookies?: Record<string, string>;
}): string | undefined => req.body?.refreshToken ?? req.cookies?.refreshToken;

const register = catchAsync(async (req, res) => {
  const result = await AuthService.register(req.body, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: 'Registration successful',
    data: result,
  });
});

const login = catchAsync(async (req, res) => {
  const result = await AuthService.login(req.body, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Login successful',
    data: result,
  });
});

const googleLogin = catchAsync(async (req, res) => {
  const result = await AuthService.googleLogin(req.body, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Google login successful',
    data: result,
  });
});

const refreshToken = catchAsync(async (req, res) => {
  const token = readRefreshToken(req);

  if (!token) {
    throw new ApiError(StatusCodes.BAD_REQUEST, 'Refresh token is required', [
      { path: 'refreshToken', message: 'Send it in the body or the refreshToken cookie' },
    ]);
  }

  const tokens = await AuthService.refresh(token, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Token refreshed successfully',
    data: tokens,
  });
});

const logout = catchAsync(async (req, res) => {
  const result = await AuthService.logout(readRefreshToken(req), req.user!.id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Logged out successfully',
    data: result,
  });
});

const changePassword = catchAsync(async (req, res) => {
  await AuthService.changePassword(req.user!.id, req.body, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Password changed successfully. Please log in again.',
  });
});

export const AuthController = {
  register,
  login,
  googleLogin,
  refreshToken,
  logout,
  changePassword,
};
