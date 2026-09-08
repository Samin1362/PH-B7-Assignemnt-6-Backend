import { PrismaClient, Difficulty, ProblemType, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const SALT_ROUNDS = 12;

/** Demo credentials handed to the evaluator — deliberately not real secrets. */
const DEMO = {
  admin: { email: 'admin@devassess.com', password: 'Admin@1234', name: 'Platform Admin' },
  company: { email: 'company@devassess.com', password: 'Company@1234', name: 'Acme Engineering' },
  candidate: { email: 'candidate@devassess.com', password: 'Candidate@1234', name: 'Rafi Ahmed' },
  candidate2: { email: 'candidate2@devassess.com', password: 'Candidate@1234', name: 'Nusrat Jahan' },
};

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

async function main(): Promise<void> {
  console.log('· seeding credit packs');
  const packs = [
    {
      name: 'Starter',
      credits: 10,
      priceCents: 2900,
      description: '10 candidate invitations — good for a single role.',
      sortOrder: 1,
    },
    {
      name: 'Growth',
      credits: 50,
      priceCents: 11900,
      description: '50 candidate invitations — for an active hiring pipeline.',
      sortOrder: 2,
    },
    {
      name: 'Scale',
      credits: 200,
      priceCents: 39900,
      description: '200 candidate invitations — for high-volume screening.',
      sortOrder: 3,
    },
  ];

  for (const pack of packs) {
    await prisma.creditPack.upsert({
      where: { slug: slugify(pack.name) },
      update: { ...pack, slug: slugify(pack.name) },
      create: { ...pack, slug: slugify(pack.name) },
    });
  }

  console.log('· seeding users');
  const [adminHash, companyHash, candidateHash] = await Promise.all([
    bcrypt.hash(DEMO.admin.password, SALT_ROUNDS),
    bcrypt.hash(DEMO.company.password, SALT_ROUNDS),
    bcrypt.hash(DEMO.candidate.password, SALT_ROUNDS),
  ]);

  await prisma.user.upsert({
    where: { email: DEMO.admin.email },
    update: {},
    create: {
      email: DEMO.admin.email,
      password: adminHash,
      name: DEMO.admin.name,
      role: Role.ADMIN,
    },
  });

  const company = await prisma.user.upsert({
    where: { email: DEMO.company.email },
    update: {},
    create: {
      email: DEMO.company.email,
      password: companyHash,
      name: DEMO.company.name,
      role: Role.COMPANY,
      companyProfile: {
        create: {
          companyName: 'Acme Engineering',
          website: 'https://acme.example.com',
          industry: 'Software',
          companySize: '51-200',
          description: 'Hiring backend and full-stack engineers.',
        },
      },
      // Seeded with a small balance so invitations are testable before Stripe
      // is wired, while still running out quickly enough to demo the 402 gate.
      creditAccount: { create: { balance: 3, totalPurchased: 3 } },
    },
  });

  const candidate = await prisma.user.upsert({
    where: { email: DEMO.candidate.email },
    update: {},
    create: {
      email: DEMO.candidate.email,
      password: candidateHash,
      name: DEMO.candidate.name,
      role: Role.CANDIDATE,
      candidateProfile: {
        create: {
          headline: 'Backend Engineer',
          skills: ['TypeScript', 'Node.js', 'PostgreSQL'],
          experienceYears: 3,
          location: 'Dhaka, Bangladesh',
        },
      },
    },
  });

  await prisma.user.upsert({
    where: { email: DEMO.candidate2.email },
    update: {},
    create: {
      email: DEMO.candidate2.email,
      password: candidateHash,
      name: DEMO.candidate2.name,
      role: Role.CANDIDATE,
      candidateProfile: {
        create: {
          headline: 'Full-stack Developer',
          skills: ['React', 'Node.js', 'Prisma'],
          experienceYears: 2,
          location: 'Chattogram, Bangladesh',
        },
      },
    },
  });

  console.log('· seeding problem bank');

  const problemSeeds = [
    {
      title: 'Two Sum',
      type: ProblemType.CODING,
      difficulty: Difficulty.EASY,
      points: 10,
      tags: ['arrays', 'hash-map'],
      language: 'javascript',
      description:
        'Given an array of integers and a target, return the indices of the two numbers that add up to the target. Print the indices space-separated.',
      starterCode: 'function twoSum(nums, target) {\n  // your code here\n}',
      testCases: [
        { input: '[2,7,11,15]\n9', expectedOutput: '0 1', weight: 1 },
        { input: '[3,2,4]\n6', expectedOutput: '1 2', weight: 1 },
        { input: '[3,3]\n6', expectedOutput: '0 1', weight: 2, isHidden: true },
      ],
    },
    {
      title: 'Reverse a Linked List',
      type: ProblemType.CODING,
      difficulty: Difficulty.MEDIUM,
      points: 20,
      tags: ['linked-list', 'pointers'],
      language: 'javascript',
      description:
        'Reverse a singly linked list given as a space-separated sequence and print the reversed sequence.',
      testCases: [
        { input: '1 2 3 4 5', expectedOutput: '5 4 3 2 1', weight: 1 },
        { input: '1', expectedOutput: '1', weight: 1 },
        { input: '1 2', expectedOutput: '2 1', weight: 1, isHidden: true },
      ],
    },
    {
      title: 'Longest Substring Without Repeating Characters',
      type: ProblemType.CODING,
      difficulty: Difficulty.HARD,
      points: 30,
      tags: ['strings', 'sliding-window'],
      language: 'javascript',
      description:
        'Given a string, print the length of the longest substring without repeating characters.',
      testCases: [
        { input: 'abcabcbb', expectedOutput: '3', weight: 1 },
        { input: 'bbbbb', expectedOutput: '1', weight: 1 },
        { input: 'pwwkew', expectedOutput: '3', weight: 2, isHidden: true },
      ],
    },
    {
      title: 'What does the HTTP 409 status code indicate?',
      type: ProblemType.MCQ,
      difficulty: Difficulty.EASY,
      points: 5,
      tags: ['http', 'rest'],
      description: 'Select the most accurate meaning of the 409 status code.',
      options: [
        { text: 'The request conflicts with the current state of the resource', isCorrect: true },
        { text: 'The server refuses to authorise the request', isCorrect: false },
        { text: 'The requested resource no longer exists', isCorrect: false },
        { text: 'The request payload is too large', isCorrect: false },
      ],
    },
    {
      title: 'Which PostgreSQL isolation level prevents phantom reads?',
      type: ProblemType.MCQ,
      difficulty: Difficulty.MEDIUM,
      points: 10,
      tags: ['database', 'transactions'],
      description: 'Choose the isolation level that eliminates phantom reads.',
      options: [
        { text: 'Read Uncommitted', isCorrect: false },
        { text: 'Read Committed', isCorrect: false },
        { text: 'Repeatable Read', isCorrect: false },
        { text: 'Serializable', isCorrect: true },
      ],
    },
    {
      title: 'Which index type suits equality lookups on a UUID column?',
      type: ProblemType.MCQ,
      difficulty: Difficulty.MEDIUM,
      points: 10,
      tags: ['database', 'indexing'],
      description: 'Pick the most appropriate index type.',
      options: [
        { text: 'B-tree', isCorrect: true },
        { text: 'GIN', isCorrect: false },
        { text: 'BRIN', isCorrect: false },
        { text: 'GiST', isCorrect: false },
      ],
    },
    {
      title: 'Explain how you would prevent a double-spend on a shared balance',
      type: ProblemType.WRITTEN,
      difficulty: Difficulty.HARD,
      points: 25,
      tags: ['concurrency', 'transactions'],
      description:
        'Two concurrent requests each try to deduct from the same account balance. Describe how you would guarantee the balance is never overdrawn, and name the trade-offs of your approach.',
    },
    {
      title: 'Describe your approach to idempotent webhook handling',
      type: ProblemType.WRITTEN,
      difficulty: Difficulty.MEDIUM,
      points: 20,
      tags: ['payments', 'webhooks'],
      description:
        'A payment provider may deliver the same webhook event more than once. Explain how you would ensure repeated delivery does not corrupt state.',
    },
  ];

  const createdProblems = [];
  for (const seed of problemSeeds) {
    const { testCases, options, ...rest } = seed as typeof seed & {
      testCases?: { input: string; expectedOutput: string; weight: number; isHidden?: boolean }[];
      options?: { text: string; isCorrect: boolean }[];
    };

    const problem = await prisma.problem.upsert({
      where: { slug: slugify(seed.title) },
      update: {},
      create: {
        ...rest,
        slug: slugify(seed.title),
        ownerId: company.id,
        isPublic: true,
        options: options
          ? { create: options.map((o, i) => ({ ...o, sortOrder: i + 1 })) }
          : undefined,
        testCases: testCases
          ? { create: testCases.map((t, i) => ({ ...t, sortOrder: i + 1 })) }
          : undefined,
      },
    });
    createdProblems.push(problem);
  }

  console.log('· seeding a draft assessment');
  const assessmentSlug = 'backend-engineer-screening';
  const existing = await prisma.assessment.findUnique({ where: { slug: assessmentSlug } });

  if (!existing) {
    const selected = createdProblems.slice(0, 5);
    await prisma.assessment.create({
      data: {
        companyId: company.id,
        title: 'Backend Engineer Screening',
        slug: assessmentSlug,
        description:
          'A 60-minute screening covering algorithms, HTTP semantics and database fundamentals.',
        durationMinutes: 60,
        passingScore: 60,
        problems: {
          create: selected.map((problem, index) => ({
            problemId: problem.id,
            order: index + 1,
            points: problem.points,
          })),
        },
      },
    });
  }

  const counts = {
    users: await prisma.user.count(),
    creditPacks: await prisma.creditPack.count(),
    problems: await prisma.problem.count(),
    assessments: await prisma.assessment.count(),
    assessmentProblems: await prisma.assessmentProblem.count(),
    options: await prisma.problemOption.count(),
    testCases: await prisma.testCase.count(),
  };

  console.log('\nSeed complete:', counts);
  console.log('\nDemo credentials');
  console.table(
    Object.entries(DEMO).map(([key, value]) => ({
      account: key,
      email: value.email,
      password: value.password,
    })),
  );
  void candidate;
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
