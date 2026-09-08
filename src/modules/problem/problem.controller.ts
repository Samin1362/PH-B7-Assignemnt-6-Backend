import { StatusCodes } from 'http-status-codes';
import { requestContext } from '../../utils/audit';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/sendResponse';
import { ProblemService } from './problem.service';
import { ListProblemQuery } from './problem.validation';

const create = catchAsync(async (req, res) => {
  const data = await ProblemService.create(req.body, req.user!, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: 'Problem created successfully',
    data,
  });
});

const list = catchAsync(async (req, res) => {
  const query = (req.validatedQuery ?? req.query) as ListProblemQuery;
  const { data, meta } = await ProblemService.list(query, req.user!);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Problems retrieved successfully',
    meta,
    data,
  });
});

const getById = catchAsync(async (req, res) => {
  const data = await ProblemService.getById(req.params.id, req.user!);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Problem retrieved successfully',
    data,
  });
});

const update = catchAsync(async (req, res) => {
  const data = await ProblemService.update(
    req.params.id,
    req.body,
    req.user!,
    requestContext(req),
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Problem updated successfully',
    data,
  });
});

const remove = catchAsync(async (req, res) => {
  await ProblemService.softDelete(req.params.id, req.user!, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Problem deleted successfully',
  });
});

const addTestCases = catchAsync(async (req, res) => {
  const data = await ProblemService.addTestCases(
    req.params.id,
    req.body.testCases,
    req.user!,
    requestContext(req),
  );

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: 'Test cases added successfully',
    data,
  });
});

const removeTestCase = catchAsync(async (req, res) => {
  await ProblemService.removeTestCase(
    req.params.id,
    req.params.testCaseId,
    req.user!,
    requestContext(req),
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Test case removed successfully',
  });
});

export const ProblemController = {
  create,
  list,
  getById,
  update,
  remove,
  addTestCases,
  removeTestCase,
};
