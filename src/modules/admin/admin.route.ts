import { Role } from '@prisma/client';
import { Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { auth } from '../../middlewares/auth';
import { validateRequest } from '../../middlewares/validateRequest';
import { requestContext } from '../../utils/audit';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/sendResponse';
import { AdminService } from './admin.service';
import { AdminValidation, AuditLogQuery, ListUsersQuery } from './admin.validation';

const router = Router();

// Every route below is admin-only; declaring it once removes the chance of
// forgetting the guard on a later addition.
router.use(auth(Role.ADMIN));

router.get(
  '/users',
  validateRequest(AdminValidation.listUsers),
  catchAsync(async (req, res) => {
    const query = (req.validatedQuery ?? req.query) as ListUsersQuery;
    const { data, meta } = await AdminService.listUsers(query);
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: 'Users retrieved successfully',
      meta,
      data,
    });
  }),
);

router.patch(
  '/users/:id/role',
  validateRequest(AdminValidation.changeRole),
  catchAsync(async (req, res) => {
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: `Role updated to ${req.body.role}`,
      data: await AdminService.changeRole(req.params.id, req.body, req.user!, requestContext(req)),
    });
  }),
);

router.patch(
  '/users/:id/status',
  validateRequest(AdminValidation.changeStatus),
  catchAsync(async (req, res) => {
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: req.body.isActive ? 'User unblocked' : 'User blocked and sessions revoked',
      data: await AdminService.changeStatus(req.params.id, req.body, req.user!, requestContext(req)),
    });
  }),
);

router.delete(
  '/users/:id',
  validateRequest(AdminValidation.removeUser),
  catchAsync(async (req, res) => {
    await AdminService.removeUser(req.params.id, req.user!, requestContext(req));
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: 'User deleted successfully',
    });
  }),
);

router.post(
  '/credits/adjust',
  validateRequest(AdminValidation.adjustCredits),
  catchAsync(async (req, res) => {
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: 'Credit balance adjusted',
      data: await AdminService.adjustCredits(req.body, req.user!, requestContext(req)),
    });
  }),
);

router.get(
  '/dashboard-stats',
  catchAsync(async (_req, res) => {
    const { data, cached } = await AdminService.getDashboardStats();
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: `Dashboard statistics retrieved${cached ? ' (from cache)' : ''}`,
      data: { ...data, cached },
    });
  }),
);

router.get(
  '/audit-logs',
  validateRequest(AdminValidation.auditLogs),
  catchAsync(async (req, res) => {
    const query = (req.validatedQuery ?? req.query) as AuditLogQuery;
    const { data, meta } = await AdminService.listAuditLogs(query);
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: 'Audit logs retrieved successfully',
      meta,
      data,
    });
  }),
);

export const AdminRoutes = router;
