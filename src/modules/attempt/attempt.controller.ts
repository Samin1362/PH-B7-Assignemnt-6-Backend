import { StatusCodes } from 'http-status-codes';
import { requestContext } from '../../utils/audit';
import { catchAsync } from '../../utils/catchAsync';
import { sendResponse } from '../../utils/sendResponse';
import { AttemptQuery } from './attempt.query';
import { AttemptService } from './attempt.service';
import { AssessmentAttemptQuery, MyAttemptQuery } from './attempt.validation';

const start = catchAsync(async (req, res) => {
  const data = await AttemptService.start(req.body.token, req.user!, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: 'Attempt started. The timer is running.',
    data,
  });
});

const getById = catchAsync(async (req, res) => {
  const data = await AttemptQuery.getForCandidate(req.params.id, req.user!);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Attempt retrieved successfully',
    data,
  });
});

const saveAnswer = catchAsync(async (req, res) => {
  const data = await AttemptService.saveAnswer(req.params.id, req.body, req.user!);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Answer saved',
    data,
  });
});

const submit = catchAsync(async (req, res) => {
  const data = await AttemptService.submit(req.params.id, req.user!, requestContext(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Attempt submitted and scored',
    data,
  });
});

const listMine = catchAsync(async (req, res) => {
  const query = (req.validatedQuery ?? req.query) as MyAttemptQuery;
  const { data, meta } = await AttemptQuery.listMine(query, req.user!);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Your attempts retrieved successfully',
    meta,
    data,
  });
});

const listForAssessment = catchAsync(async (req, res) => {
  const query = (req.validatedQuery ?? req.query) as AssessmentAttemptQuery;
  const { data, meta } = await AttemptQuery.listForAssessment(req.params.id, query, req.user!);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Attempts retrieved successfully',
    meta,
    data,
  });
});

const evaluate = catchAsync(async (req, res) => {
  const data = await AttemptQuery.evaluateSubmission(
    req.params.id,
    req.body,
    req.user!,
    requestContext(req),
  );

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Submission evaluated',
    data,
  });
});

export const AttemptController = {
  start, getById, saveAnswer, submit, listMine, listForAssessment, evaluate,
};
