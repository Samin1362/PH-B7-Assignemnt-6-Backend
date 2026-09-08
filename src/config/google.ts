import { OAuth2Client } from 'google-auth-library';
import { StatusCodes } from 'http-status-codes';
import { ApiError } from '../utils/ApiError';
import { config } from './env';

const client = config.features.google ? new OAuth2Client(config.GOOGLE_CLIENT_ID) : null;

export interface GoogleIdentity {
  googleId: string;
  email: string;
  name: string;
  avatarUrl?: string;
}

/**
 * Verifies a Google-issued ID token against Google's public keys and checks it
 * was minted for this client. Returns the identity claims we persist.
 */
export const verifyGoogleIdToken = async (idToken: string): Promise<GoogleIdentity> => {
  if (!client) {
    throw new ApiError(StatusCodes.SERVICE_UNAVAILABLE, 'Google login is not configured', [
      { path: 'GOOGLE_CLIENT_ID', message: 'Set GOOGLE_CLIENT_ID to enable social login' },
    ]);
  }

  const ticket = await client.verifyIdToken({
    idToken,
    audience: config.GOOGLE_CLIENT_ID,
  });

  const payload = ticket.getPayload();

  if (!payload?.sub || !payload.email) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Google token did not contain an email', [
      { path: 'idToken', message: 'Token payload is missing required claims' },
    ]);
  }

  if (payload.email_verified === false) {
    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Google account email is not verified', [
      { path: 'idToken', message: 'Verify your email with Google before signing in' },
    ]);
  }

  return {
    googleId: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name ?? payload.email.split('@')[0],
    avatarUrl: payload.picture,
  };
};
