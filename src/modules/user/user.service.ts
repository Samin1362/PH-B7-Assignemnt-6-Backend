import { Role } from '@prisma/client';
import { StatusCodes } from 'http-status-codes';
import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { logAudit } from '../../utils/audit';
import { publicUserSelect, PublicUser } from './user.constant';
import { CandidateProfileInput, CompanyProfileInput, UpdateMeInput } from './user.validation';

interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * The current user plus whatever side-tables their role owns. A COMPANY also
 * gets its credit balance, since almost every company screen needs it and this
 * saves a second round trip.
 */
const getMe = async (userId: string): Promise<Record<string, unknown>> => {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      ...publicUserSelect,
      candidateProfile: true,
      companyProfile: true,
      creditAccount: {
        select: { balance: true, totalPurchased: true, totalConsumed: true },
      },
    },
  });

  if (!user) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  const { candidateProfile, companyProfile, creditAccount, ...base } = user;

  if (user.role === Role.CANDIDATE) {
    return { ...base, profile: candidateProfile };
  }

  if (user.role === Role.COMPANY) {
    return { ...base, profile: companyProfile, credits: creditAccount };
  }

  return { ...base, profile: null };
};

const updateMe = async (
  userId: string,
  input: UpdateMeInput,
  meta: ClientMeta,
): Promise<PublicUser> => {
  const before = await prisma.user.findUnique({
    where: { id: userId },
    select: { name: true, avatarUrl: true },
  });

  if (!before) {
    throw new ApiError(StatusCodes.NOT_FOUND, 'User not found');
  }

  const updated = await prisma.user.update({
    where: { id: userId },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
    },
    select: publicUserSelect,
  });

  await logAudit({
    actorId: userId,
    action: 'USER_UPDATED_PROFILE',
    entity: 'User',
    entityId: userId,
    before,
    after: { name: updated.name, avatarUrl: updated.avatarUrl },
    ...meta,
  });

  return updated;
};

/** Role-aware read: each role sees the profile table it actually owns. */
const getMyProfile = async (
  userId: string,
  role: Role,
): Promise<{ type: string; profile: unknown }> => {
  if (role === Role.CANDIDATE) {
    const profile = await prisma.candidateProfile.findUnique({ where: { userId } });
    return { type: 'CANDIDATE', profile };
  }

  if (role === Role.COMPANY) {
    const profile = await prisma.companyProfile.findUnique({ where: { userId } });
    return { type: 'COMPANY', profile };
  }

  // An admin owns no profile table; that is a valid state, not an error.
  return { type: 'NONE', profile: null };
};

/**
 * PUT semantics: the supplied body replaces the profile wholesale. Upsert
 * rather than update, so a profile row that was never created (or was removed)
 * is repaired instead of throwing.
 */
const upsertCandidateProfile = async (
  userId: string,
  input: CandidateProfileInput,
  meta: ClientMeta,
): Promise<unknown> => {
  const before = await prisma.candidateProfile.findUnique({ where: { userId } });

  const profile = await prisma.candidateProfile.upsert({
    where: { userId },
    update: input,
    create: { ...input, userId },
  });

  await logAudit({
    actorId: userId,
    action: before ? 'CANDIDATE_PROFILE_UPDATED' : 'CANDIDATE_PROFILE_CREATED',
    entity: 'CandidateProfile',
    entityId: profile.id,
    before,
    after: profile,
    ...meta,
  });

  return profile;
};

const upsertCompanyProfile = async (
  userId: string,
  input: CompanyProfileInput,
  meta: ClientMeta,
): Promise<unknown> => {
  const before = await prisma.companyProfile.findUnique({ where: { userId } });

  const profile = await prisma.companyProfile.upsert({
    where: { userId },
    update: input,
    create: { ...input, userId },
  });

  await logAudit({
    actorId: userId,
    action: before ? 'COMPANY_PROFILE_UPDATED' : 'COMPANY_PROFILE_CREATED',
    entity: 'CompanyProfile',
    entityId: profile.id,
    before,
    after: profile,
    ...meta,
  });

  return profile;
};

export const UserService = {
  getMe,
  updateMe,
  getMyProfile,
  upsertCandidateProfile,
  upsertCompanyProfile,
};
