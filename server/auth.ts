import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';
import { z } from 'zod';
import type { SessionInfo } from '../shared/types';
import { safeEqual, type SecretBox } from './crypto';

const COOKIE = 'sms_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000;

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}

/**
 * Optional single-password protection for the dashboard and API. Enabled when
 * ADMIN_PASSWORD is set. Sessions are stateless signed cookies.
 */
export class Auth {
  private attempts = new Map<string, { count: number; first: number }>();

  constructor(
    private readonly password: string | null,
    private readonly box: SecretBox,
    private readonly secureCookies: boolean,
    private readonly desktop = false,
  ) {}

  get enabled(): boolean {
    return this.password !== null;
  }

  private issue(): string {
    const expires = String(Date.now() + SESSION_TTL_MS);
    return `${expires}.${this.box.sign(`session:${expires}`)}`;
  }

  isAuthenticated(req: Request): boolean {
    if (!this.enabled) return true;
    const token = readCookie(req, COOKIE);
    if (!token) return false;
    const [expires, signature] = token.split('.');
    if (!expires || !signature || Number(expires) < Date.now()) return false;
    return this.box.verify(`session:${expires}`, signature);
  }

  session(req: Request): SessionInfo {
    return { authRequired: this.enabled, authenticated: this.isAuthenticated(req), desktop: this.desktop };
  }

  private rateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || now - entry.first > WINDOW_MS) {
      this.attempts.set(ip, { count: 1, first: now });
      return false;
    }
    entry.count += 1;
    return entry.count > MAX_ATTEMPTS;
  }

  routes(): Router {
    const router = express.Router();
    router.get('/session', (req, res) => {
      res.json(this.session(req));
    });

    router.post('/login', (req, res) => {
      if (!this.enabled) {
        res.json(this.session(req));
        return;
      }
      if (this.rateLimited(req.ip ?? 'unknown')) {
        res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
        return;
      }
      const parsed = z.object({ password: z.string().max(500) }).safeParse(req.body);
      if (!parsed.success || !safeEqual(parsed.data.password, this.password!)) {
        res.status(401).json({ error: 'Incorrect password' });
        return;
      }
      this.attempts.delete(req.ip ?? 'unknown');
      res.cookie(COOKIE, this.issue(), {
        httpOnly: true,
        sameSite: 'strict',
        secure: this.secureCookies,
        maxAge: SESSION_TTL_MS,
        path: '/',
      });
      res.json({ authRequired: true, authenticated: true, desktop: this.desktop } satisfies SessionInfo);
    });

    router.post('/logout', (_req, res) => {
      res.clearCookie(COOKIE, { path: '/' });
      res.json({ authRequired: this.enabled, authenticated: !this.enabled, desktop: this.desktop } satisfies SessionInfo);
    });
    return router;
  }

  middleware() {
    return (req: Request, res: Response, next: NextFunction) => {
      if (this.isAuthenticated(req)) return next();
      res.status(401).json({ error: 'Sign in required' });
    };
  }
}
