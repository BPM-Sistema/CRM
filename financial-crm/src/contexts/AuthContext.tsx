import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import {
  login as apiLogin,
  logout as apiLogout,
  getStoredUser,
  isAuthenticated as checkIsAuthenticated,
  refreshUserPermissions,
  AuthUser,
} from '../services/api';

interface AuthContextType {
  isAuthenticated: boolean;
  user: AuthUser | null;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
  hasPermission: (permission: string) => boolean;
  loading: boolean;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Verificar si ya hay una sesión guardada
    const authenticated = checkIsAuthenticated();
    const storedUser = getStoredUser();

    if (authenticated && storedUser) {
      setIsAuthenticated(true);
      setUser(storedUser);
    }

    setLoading(false);
  }, []);

  // Refrescar permisos cuando el usuario vuelve a la pestaña
  useEffect(() => {
    const handleVisibilityChange = async () => {
      console.log('[Auth] Visibility changed:', document.visibilityState);
      if (document.visibilityState === 'visible' && isAuthenticated) {
        console.log('[Auth] Refreshing permissions...');
        const freshUser = await refreshUserPermissions();
        if (freshUser) {
          console.log('[Auth] Permissions updated:', freshUser.permissions);
          setUser(freshUser);
        } else {
          console.log('[Auth] Failed to refresh permissions');
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [isAuthenticated]);

  const login = async (email: string, password: string): Promise<boolean> => {
    try {
      const result = await apiLogin(email, password);
      setIsAuthenticated(true);
      setUser(result.user);
      return true;
    } catch {
      return false;
    }
  };

  const logout = () => {
    apiLogout();
    setIsAuthenticated(false);
    setUser(null);
  };

  const hasPermission = (permission: string): boolean => {
    if (!user) return false;
    return user.permissions.includes(permission);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-neutral-300 border-t-neutral-900 rounded-full"></div>
      </div>
    );
  }

  return (
    <AuthContext.Provider value={{ isAuthenticated, user, login, logout, hasPermission, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
