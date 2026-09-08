import { StatusCodes } from 'http-status-codes';
import { requestContext } from '../../utils/audit';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/sendResponse';
import { InvitationService } from './invitation.service';
import { ListInvitationQuery, MyInvitationQuery } from './invitation.validation';

const create = catchAsync(async (req, res) => {
  const data = await InvitationService.create(
    req.params.id,
    req.body,
    req.user!,
    requestContext(req),
  );

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: `Invited ${data.creditsSpent} candidate(s)`,
    data,
  });
});

const listForAssessment = catchAsync(async (req, res) => {
  const query = (req.validatedQuery ?? req.query) as ListInvitationQuery;
  const { data, meta } = await InvitationService.listForAssessment(req.params.id, query, req.user!);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Invitations retrieved successfully',
    meta,
    data,
  });
});

const revoke = catchAsync(async (req, res) => {
  const data = await InvitationService.revoke(req.params.id, req.user!, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Invitation revoked and credit refunded',
    data,
  });
});

const listMine = catchAsync(async (req, res) => {
  const query = (req.validatedQuery ?? req.query) as MyInvitationQuery;
  const { data, meta } = await InvitationService.listMine(query, req.user!);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Your invitations retrieved successfully',
    meta,
    data,
  });
});

export const InvitationController = { create, listForAssessment, revoke, listMine };
