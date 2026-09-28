import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy } from 'passport-google-oauth20';
@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  constructor() { super({ clientID: process.env.GOOGLE_CLIENT_ID || 'disabled', clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'disabled', callbackURL: process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3000/api/v1/auth/google/callback', scope: ['email', 'profile'] }); }
  validate(_: string, __: string, profile: Profile) {
    const email = profile.emails?.find((entry) => entry.verified)?.value;
    return { googleId: profile.id, email, emailVerified: Boolean(email) };
  }
}
