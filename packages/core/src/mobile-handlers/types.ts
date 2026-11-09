

/**
 * Standardized response to mobile bridge
 */
interface MobileResponse {
  id: string;
  status: number;
  data?: any;
  error?: string;
}

/**
 * User context resolved from session
 */
export interface MobileUserContext {
  userId: string;
  username: string;
  role: 'owner' | 'guest' | 'anonymous';
  isAuthenticated: boolean;
}

/**
 * Create a success response
 */
export function successResponse(id: string, data: any): MobileResponse {
  return { id, status: 200, data };
}

/**
 * Create an error response
 */
export function errorResponse(id: string, status: number, error: string): MobileResponse {
  return { id, status, error };
}
