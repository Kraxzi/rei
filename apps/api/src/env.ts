export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  /** Local development only: '1' enables the X-Dev-User header instead of a session. Never set in production. */
  DEV_AUTH?: string;
  /** Secret: one-time code that allows creating the very first (owner) account. */
  BOOTSTRAP_CODE?: string;
  /** Override for the WebAuthn origin (local dev behind the Vite proxy). Defaults to the request origin. */
  WEBAUTHN_ORIGIN?: string;
}

export interface AuthUser {
  id: string;
  role: 'owner' | 'admin' | 'user';
  displayName: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: AuthUser } };
