/** Public account fields safe for the browser to display. */
export interface PublicUser {
  id: string;
  email: string;
  enabled: boolean;
  createdAt: string;
  ssoLinked: boolean;
}

/** Authenticated local user attached to an Express request by the auth guard. */
declare global {
  namespace Express {
    interface Request {
      authUser?: PublicUser;
      authSessionToken?: string;
    }
  }
}

export {};
