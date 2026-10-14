import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { endpoints } from '@/api/endpoints';
import { tokenStore, ApiError } from '@/api/client';
import type { Role, User } from '@/api/types';

interface AuthCtx {
  user: User | null;
  ready: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  hasRole: (role: Role) => boolean;
  canOperate: boolean;
  isAdmin: boolean;
  loginOpen: boolean;
  openLogin: () => void;
  closeLogin: () => void;
}

const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, admin: 2 };
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const qc = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    const token = tokenStore.get();
    if (!token) {
      setReady(true);
      return;
    }
    endpoints
      .me()
      .then((u) => {
        if (!cancelled) setUser(u);
      })
      .catch(() => {
        tokenStore.set(null);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // When the backend rejects the token (401) the client clears it; mirror that in state.
  useEffect(() => {
    const unsubscribe = tokenStore.subscribe((t) => {
      if (!t) setUser(null);
    });
    return () => {
      unsubscribe();
    };
  }, []);

  const login = useCallback(
    async (username: string, password: string) => {
      const res = await endpoints.login(username, password);
      tokenStore.set(res.access_token);
      setUser(res.user);
      setLoginOpen(false);
      qc.invalidateQueries();
    },
    [qc],
  );

  const logout = useCallback(() => {
    tokenStore.set(null);
    setUser(null);
    qc.invalidateQueries();
  }, [qc]);

  const hasRole = useCallback((role: Role) => (user ? ROLE_RANK[user.role] >= ROLE_RANK[role] : false), [user]);

  const value = useMemo<AuthCtx>(
    () => ({
      user,
      ready,
      login,
      logout,
      hasRole,
      canOperate: hasRole('operator'),
      isAdmin: hasRole('admin'),
      loginOpen,
      openLogin: () => setLoginOpen(true),
      closeLogin: () => setLoginOpen(false),
    }),
    [user, ready, login, logout, hasRole, loginOpen],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}

export function isAuthError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}
