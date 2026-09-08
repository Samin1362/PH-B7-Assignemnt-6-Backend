import { StatusCodes } from 'http-status-codes';
import { requestContext } from '../../utils/audit';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/sendResponse';
import { AssessmentService } from './assessment.service';
import { ListAssessmentQuery } from './assessment.validation';

const create = catchAsync(async (req, res) => {
  const data = await AssessmentService.create(req.body, req.user!, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: 'Assessment created successfully',
    data,
  });
});

const list = catchAsync(async (req, res) => {
  const query = (req.validatedQuery ?? req.query) as ListAssessmentQuery;
  const { data, meta } = await AssessmentService.list(query, req.user!);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Assessments retrieved successfully',
    meta,
    data,
  });
});

const getById = catchAsync(async (req, res) => {
  const data = await AssessmentService.getById(req.params.id, req.user!);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Assessment retrieved successfully',
    data,
  });
});

const update = catchAsync(async (req, res) => {
  const data = await AssessmentService.update(
    req.params.id,
    req.body,
    req.user!,
    requestContext(req),
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Assessment updated successfully',
    data,
  });
});

const changeStatus = catchAsync(async (req, res) => {
  const data = await AssessmentService.changeStatus(
    req.params.id,
    req.body.status,
    req.user!,
    requestContext(req),
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: `Assessment moved to ${req.body.status}`,
    data,
  });
});

const attachProblems = catchAsync(async (req, res) => {
  const data = await AssessmentService.attachProblems(
    req.params.id,
    req.body,
    req.user!,
    requestContext(req),
  );

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: 'Problems attached successfully',
    data,
  });
});

const detachProblem = catchAsync(async (req, res) => {
  await AssessmentService.detachProblem(
    req.params.id,
    req.params.problemId,
    req.user!,
    requestContext(req),
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Problem detached successfully',
  });
});

const remove = catchAsync(async (req, res) => {
  await AssessmentService.softDelete(req.params.id, req.user!, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Assessment deleted successfully',
  });
});

export const AssessmentController = {
  create,
  list,
  getById,
  update,
  changeStatus,
  attachProblems,
  detachProblem,
  remove,
};
