import { ProblemOption, ProblemType, TestCase } from '@prisma/client';

export interface ScoreResult {
  score: number;
  /** False when a human still has to look at it. */
  autoScored: boolean;
  testCasesPassed: number;
  testCasesTotal: number;
}

export interface AnswerPayload {
  selectedOptionId?: string | null;
  output?: string | null;
  code?: string | null;
  answerText?: string | null;
}

/**
 * Whitespace differences are formatting, not wrong answers: line endings are
 * unified, each line is trimmed, and runs of internal whitespace collapse to a
 * single space. Case is preserved — output is usually case-significant.
 */
export const normalizeOutput = (value: string): string =>
  value
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim().replace(/\s+/g, ' '))
    .filter((line, index, all) => !(line === '' && index === all.length - 1))
    .join('\n');

/** Exactly one option is correct (enforced at problem creation), so this is all-or-nothing. */
const scoreMcq = (
  selectedOptionId: string | null | undefined,
  options: ProblemOption[],
  points: number,
): ScoreResult => {
  const chosen = options.find((option) => option.id === selectedOptionId);
  return {
    score: chosen?.isCorrect ? points : 0,
    autoScored: true,
    testCasesPassed: chosen?.isCorrect ? 1 : 0,
    testCasesTotal: 1,
  };
};

/**
 * Coding answers are scored by matching the candidate's reported output against
 * the visible test cases, line for line, weighted so a partially correct
 * solution earns partial credit.
 *
 * Only visible test cases participate: the platform does not execute code, so a
 * candidate cannot produce output for inputs they were never shown. Hidden test
 * cases are retained for the evaluator, who can override the auto score through
 * PATCH /submissions/:id/evaluate.
 */
const scoreCoding = (
  output: string | null | undefined,
  testCases: TestCase[],
  points: number,
): ScoreResult => {
  const visible = testCases
    .filter((testCase) => !testCase.isHidden)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  // Nothing to match against — leave it for a human.
  if (visible.length === 0) {
    return { score: 0, autoScored: false, testCasesPassed: 0, testCasesTotal: testCases.length };
  }

  if (!output?.trim()) {
    return { score: 0, autoScored: true, testCasesPassed: 0, testCasesTotal: visible.length };
  }

  const lines = normalizeOutput(output).split('\n');
  const totalWeight = visible.reduce((sum, testCase) => sum + testCase.weight, 0);

  let earnedWeight = 0;
  let passed = 0;

  visible.forEach((testCase, index) => {
    if (lines[index] !== undefined && lines[index] === normalizeOutput(testCase.expectedOutput)) {
      earnedWeight += testCase.weight;
      passed += 1;
    }
  });

  return {
    // Rounded to 2dp so floating-point weights do not leak into totals.
    score: Math.round((points * earnedWeight) / totalWeight * 100) / 100,
    autoScored: true,
    testCasesPassed: passed,
    testCasesTotal: visible.length,
  };
};

/** Written answers are never auto-scored; they wait for an evaluator. */
const scoreWritten = (): ScoreResult => ({
  score: 0,
  autoScored: false,
  testCasesPassed: 0,
  testCasesTotal: 0,
});

export const scoreAnswer = (
  type: ProblemType,
  answer: AnswerPayload,
  points: number,
  options: ProblemOption[],
  testCases: TestCase[],
): ScoreResult => {
  switch (type) {
    case ProblemType.MCQ:
      return scoreMcq(answer.selectedOptionId, options, points);
    case ProblemType.CODING:
      return scoreCoding(answer.output, testCases, points);
    case ProblemType.WRITTEN:
      return scoreWritten();
    default:
      return scoreWritten();
  }
};
