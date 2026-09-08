import { Role } from '@prisma/client';
import crypto from 'crypto';
import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { config } from '../config/env';

export interface TokenPayload {
  sub: string;
  email: string;
  role: Role;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const sign = (payload: TokenPayload, secret: string, expiresIn: string): string =>
  jwt.sign(payload, secret, { expiresIn } as SignOptions);

export const createAccessToken = (payload: TokenPayload): string =>
  sign(payload, config.JWT_ACCESS_SECRET, config.JWT_ACCESS_EXPIRES_IN);

export const createRefreshToken = (payload: TokenPayload): string =>
  sign(payload, config.JWT_REFRESH_SECRET, config.JWT_REFRESH_EXPIRES_IN);

export const createTokenPair = (payload: TokenPayload): TokenPair => ({
  accessToken: createAccessToken(payload),
  refreshToken: createRefreshToken(payload),
});

export const verifyAccessToken = (token: string): TokenPayload & JwtPayload =>
  jwt.verify(token, config.JWT_ACCESS_SECRET) as TokenPayload & JwtPayload;

export const verifyRefreshToken = (token: string): TokenPayload & JwtPayload =>
  jwt.verify(token, config.JWT_REFRESH_SECRET) as TokenPayload & JwtPayload;

/**
 * Refresh tokens are persisted as a SHA-256 digest. They are already
 * high-entropy random strings, so a fast digest is the right primitive here —
 * bcrypt's work factor exists to slow down guessing of low-entropy passwords
 * and would only add latency to every refresh.
 */
export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

/** Reads the JWT `exp` claim so the DB row expires exactly when the token does. */
export const getTokenExpiry = (token: string): Date => {
  const decoded = jwt.decode(token) as JwtPayload | null;
  if (!decoded?.exp) {
    throw new Error('Token is missing an exp claim');
  }
  return new Date(decoded.exp * 1000);
};
