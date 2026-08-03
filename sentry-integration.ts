/**
 * ============================================================================
 *  sentry-integration.ts — Error monitoring and performance tracking
 * ----------------------------------------------------------------------------
 *  Integrates Sentry for production error monitoring, performance tracking,
 *  and real-time alerting for critical failures during live services.
 * ============================================================================
 */

'use strict';

import * as Sentry from '@sentry/node';

interface SentryConfig {
  dsn: string;
  environment: string;
  release?: string;
  tracesSampleRate?: number;
  profilesSampleRate?: number;
}

interface UserContext {
  id?: string;
  ip_address?: string;
  role?: 'operator' | 'viewer' | 'system';
}

/**
 * Initialize Sentry for error monitoring
 * @param config - Sentry configuration
 */
function initSentry(config: SentryConfig): void {
  if (!config.dsn) {
    console.warn('[sentry] DSN not provided, Sentry disabled');
    return;
  }

  Sentry.init({
    dsn: config.dsn,
    environment: config.environment || process.env.NODE_ENV || 'production',
    release: config.release || process.env.npm_package_version || '0.5.0',

    // Performance monitoring
    tracesSampleRate: config.tracesSampleRate || 0.1, // 10% of transactions

    // Session replay (optional, for debugging)
    // sessionReplay: {
    //   sessionSampleRate: 0.1,
    //   errorSampleRate: 1.0,
    // },

    // beforeSend filter to filter out expected errors
    beforeSend(event, hint) {
      // Filter out expected/low-priority errors
      if (event.exception) {
        const error = hint.originalException;

        // Don't send network timeout errors
        if (error instanceof Error && error.message.includes('timeout')) {
          return null;
        }

        // Don't send rate limit errors
        if (error instanceof Error && error.message.includes('rate limit')) {
          return null;
        }
      }

      // Add custom context
      event.contexts = {
        ...event.contexts,
        app: {
          name: 'ChurchOverlay',
          type: 'electron-app',
        },
      };

      return event;
    },

    // beforeSendTransaction for performance filtering
    beforeSendTransaction(transaction) {
      // Filter out health check transactions
      if (transaction.name === 'health-check') {
        return null;
      }
      return transaction;
    },

    // Integrations
    integrations: [
      // Add HTTP request tracking
      new Sentry.Integrations.Http({ tracing: true }),
      // Add performance monitoring
      new Sentry.Integrations.FunctionToString(),
      new Sentry.Integrations.LinkedErrors(),
      new Sentry.Integrations.RequestData(),
    ],

    // Set initial scope
    initialScope: {
      tags: {
        component: 'churchoverlay',
      },
    },
  });

  console.log('[sentry] Initialized successfully');
}

/**
 * Set user context for better error tracking
 * @param user - User context information
 */
function setUser(user: UserContext): void {
  Sentry.setUser(user);
}

/**
 * Clear user context
 */
function clearUser(): void {
  Sentry.setUser(null);
}

/**
 * Capture an exception with additional context
 * @param error - Error to capture
 * @param context - Additional context
 * @param level - Error level
 */
function captureException(
  error: Error | unknown,
  context: Record<string, any> = {},
  level: 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug' = 'error'
): void {
  Sentry.withScope((scope) => {
    // Add additional context
    Object.entries(context).forEach(([key, value]) => {
      scope.setContext(key, value);
    });

    // Set level
    scope.setLevel(level);

    // Capture exception
    if (error instanceof Error) {
      Sentry.captureException(error);
    } else {
      Sentry.captureException(new Error(String(error)));
    }
  });
}

/**
 * Capture a message with level
 * @param message - Message to capture
 * @param level - Message level
 * @param context - Additional context
 */
function captureMessage(
  message: string,
  level: 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug' = 'info',
  context: Record<string, any> = {}
): void {
  Sentry.withScope((scope) => {
    Object.entries(context).forEach(([key, value]) => {
      scope.setContext(key, value);
    });

    scope.setLevel(level);
    Sentry.captureMessage(message);
  });
}

/**
 * Start a performance transaction
 * @param name - Transaction name
 * @param operation - Operation type
 * @returns - Transaction object
 */
function startTransaction(name: string, operation: string = 'custom') {
  return Sentry.startTransaction({
    name,
    op: operation,
  });
}

/**
 * Add breadcrumb for better error context
 * @param category - Breadcrumb category
 * @param message - Breadcrumb message
 * @param data - Additional data
 */
function addBreadcrumb(category: string, message: string, data: Record<string, any> = {}): void {
  Sentry.addBreadcrumb({
    category,
    message,
    level: 'info',
    data,
  });
}

/**
 * Set tag for filtering in Sentry dashboard
 * @param key - Tag key
 * @param value - Tag value
 */
function setTag(key: string, value: string): void {
  Sentry.setTag(key, value);
}

/**
 * Set extra context
 * @param key - Context key
 * @param value - Context value
 */
function setExtra(key: string, value: any): void {
  Sentry.setExtra(key, value);
}

/**
 * Flush pending events before application shutdown
 * @param timeout - Maximum time to wait (ms)
 * @returns - Promise that resolves when flushed
 */
async function flush(timeout: number = 2000): Promise<boolean> {
  try {
    await Sentry.flush(timeout);
    return true;
  } catch (error) {
    console.error('[sentry] Error flushing events:', error);
    return false;
  }
}

/**
 * Shutdown Sentry client
 * @param timeout - Maximum time to wait (ms)
 * @returns - Promise that resolves when shutdown
 */
async function close(timeout: number = 2000): Promise<boolean> {
  try {
    await Sentry.close(timeout);
    return true;
  } catch (error) {
    console.error('[sentry] Error closing Sentry:', error);
    return false;
  }
}

/**
 * Create a wrapper for async functions with error monitoring
 * @param fn - Async function to wrap
 * @param context - Context for error reporting
 * @returns - Wrapped function
 */
function withErrorMonitoring<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  context: Record<string, any> = {}
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await fn(...args);
    } catch (error) {
      captureException(error, {
        ...context,
        functionName: fn.name,
        arguments: args,
      });
      throw error;
    }
  }) as T;
}

/**
 * Monitor WebSocket connection lifecycle
 * @param ws - WebSocket connection
 * @param context - Connection context
 */
function monitorWebSocket(ws: any, context: Record<string, any> = {}): void {
  const connectionId = context.connectionId || 'unknown';

  addBreadcrumb('websocket', 'Connection established', {
    connectionId,
    ...context,
  });

  ws.on('error', (error: Error) => {
    captureException(
      error,
      {
        ...context,
        connectionId,
        phase: 'websocket-error',
      },
      'error'
    );
  });

  ws.on('close', (code: number, reason: string) => {
    addBreadcrumb('websocket', 'Connection closed', {
      connectionId,
      code,
      reason,
    });
  });
}

/**
 * Monitor API calls with performance tracking
 * @param apiName - API name
 * @param fn - API function to monitor
 * @returns - Wrapped function
 */
function monitorAPICall<T extends (...args: any[]) => Promise<any>>(apiName: string, fn: T): T {
  return (async (...args: Parameters<T>) => {
    const transaction = startTransaction(`api-${apiName}`, 'api-call');

    try {
      addBreadcrumb('api', `Calling ${apiName}`, { apiName });

      const result = await fn(...args);

      setTag('api.success', 'true');
      setTag('api.name', apiName);

      return result;
    } catch (error) {
      setTag('api.success', 'false');
      setTag('api.name', apiName);

      captureException(error, {
        apiName,
        phase: 'api-call',
        arguments: args,
      });

      throw error;
    } finally {
      transaction.finish();
    }
  }) as T;
}

export {
  initSentry,
  setUser,
  clearUser,
  captureException,
  captureMessage,
  startTransaction,
  addBreadcrumb,
  setTag,
  setExtra,
  flush,
  close,
  withErrorMonitoring,
  monitorWebSocket,
  monitorAPICall,
};

export type { SentryConfig, UserContext };
