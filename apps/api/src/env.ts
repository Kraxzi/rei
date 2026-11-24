export interface Env {
  DB: D1Database;
  ENVIRONMENT: string;
  /** Local development only: '1' enables the X-Dev-User header instead of a session. Never set in production. */
  DEV_AUTH?: string;
}

export interface AuthUser {
  id: string;
  role: 'owner' | 'admin' | 'user';
  displayName: string;
}

export type AppEnv = { Bindings: Env; Variables: { user: AuthUser } };
