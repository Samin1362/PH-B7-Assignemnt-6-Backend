import { StatusCodes } from 'http-status-codes';
import { requestContext } from '../../utils/audit';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/sendResponse';
import { UserService } from './user.service';

const getMe = catchAsync(async (req, res) => {
  const data = await UserService.getMe(req.user!.id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Profile retrieved successfully',
    data,
  });
});

const updateMe = catchAsync(async (req, res) => {
  const data = await UserService.updateMe(req.user!.id, req.body, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Account updated successfully',
    data,
  });
});

const getMyProfile = catchAsync(async (req, res) => {
  const data = await UserService.getMyProfile(req.user!.id, req.user!.role);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Profile retrieved successfully',
    data,
  });
});

const updateCandidateProfile = catchAsync(async (req, res) => {
  const data = await UserService.upsertCandidateProfile(
    req.user!.id,
    req.body,
    requestContext(req),
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Candidate profile saved successfully',
    data,
  });
});

const updateCompanyProfile = catchAsync(async (req, res) => {
  const data = await UserService.upsertCompanyProfile(req.user!.id, req.body, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Company profile saved successfully',
    data,
  });
});

export const UserController = {
  getMe,
  updateMe,
  getMyProfile,
  updateCandidateProfile,
  updateCompanyProfile,
};
