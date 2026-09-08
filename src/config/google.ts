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

  let payload;

  try {
    const ticket = await client.verifyIdToken({
      idToken,
      audience: config.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload();
  } catch (error) {
    /*
     * Any failure here - malformed token, bad signature, expired, wrong
     * audience - is the caller presenting a token we will not accept. That is
     * a 401, not a server fault, and the library's internal wording
     * ("No pem found for envelope", "Wrong number of segments") is noise to an
     * API consumer, so the detail is logged rather than returned.
     */
    console.error('[google] id token rejected:', (error as Error).message);

    throw new ApiError(StatusCodes.UNAUTHORIZED, 'Google sign-in failed', [
      { path: 'idToken', message: 'The Google token is invalid, expired, or was issued for a different application' },
    ]);
  }

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
