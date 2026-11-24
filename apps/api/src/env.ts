import type { Job } from './sources/discovery.js';

export interface Env {
  DB: D1Database;
  /** Background jobs: source discovery and audits. */
  JOBS: Queue<Job>;
  ENVIRONMENT: string;
  /** Local development only: '1' enables the X-Dev-User header instead of a session. Never set in production. */
  DEV_AUTH?: string;
  /** Secret: one-time code that allows creating the very first (owner) account. */
  BOOTSTRAP_CODE?: string;
  /** Override for the WebAuthn origin (local dev behind the Vite proxy). Defaults to the request origin. */
  WEBAUTHN_ORIGIN?: string;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL_LITE?: string;
  GEMINI_MODEL_DEEP?: string;
  /** Max AI calls per UTC day (free-tier guard). */
  AI_DAILY_LIMIT?: string;
}

export interface AuthUser {
  id: string;
  role: 'owner' | 'admin' | 'user';
  displayName: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: AuthUser } };
