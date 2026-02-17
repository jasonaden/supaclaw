/**
 * Error handling and retry logic for Supaclaw
 * 
 * Provides:
 * - Custom error types
 * - Retry logic with exponential backoff
 * - Circuit breaker pattern
 * - Error recovery strategies
 */

// Custom error types
export class SupaclawError extends Error {
  constructor(message: string, public code: string, public details?: unknown) {
    super(message);
    this.name = 'SupaclawError';
  }
}

export class DatabaseError extends SupaclawError {
  constructor(message: string, details?: unknown) {
    super(message, 'DATABASE_ERROR', details);
    this.name = 'DatabaseError';
  }
}

export class EmbeddingError extends SupaclawError {
  constructor(message: string, details?: unknown) {
    super(message, 'EMBEDDING_ERROR', details);
    this.name = 'EmbeddingError';
  }
}

export class ValidationError extends SupaclawError {
  constructor(message: string, details?: unknown) {
    super(message, 'VALIDATION_ERROR', details);
    this.name = 'ValidationError';
  }
}

export class RateLimitError extends SupaclawError {
  constructor(message: string, details?: unknown) {
    super(message, 'RATE_LIMIT_ERROR', details);
    this.name = 'RateLimitError';
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  shouldRetry?: (error: Error) => boolean;
  onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  shouldRetry: (error: Error) => {
    // Retry on network errors, rate limits, and transient database errors
    if (error instanceof RateLimitError) return true;
    if (error instanceof DatabaseError) {
      // Don't retry validation/constraint errors
      const msg = error.message.toLowerCase();
      return !msg.includes('constraint') && !msg.includes('invalid');
    }
    // Retry on network errors
    if (error.message.includes('ECONNREFUSED')) return true;
    if (error.message.includes('ETIMEDOUT')) return true;
    if (error.message.includes('ENOTFOUND')) return true;
    return false;
  },
  onRetry: () => {}, // No-op by default
};

/**
 * Retry a function with exponential backoff
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      // Don't retry if we've exhausted attempts or error is non-retryable
      if (attempt >= opts.maxAttempts || !opts.shouldRetry(lastError)) {
        throw lastError;
      }

      // Calculate delay with exponential backoff
      const delay = Math.min(
        opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt - 1),
        opts.maxDelayMs
      );

      opts.onRetry(attempt, lastError);

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

/**
 * Circuit breaker pattern
 * Prevents cascading failures by failing fast when error rate is high
 */
export class CircuitBreaker {
  private failures = 0;
  private successes = 0;
  private lastFailureTime = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';

  constructor(
    private failureThreshold = 5,
    private recoveryTimeMs = 60000, // 1 minute
    private successThreshold = 2
  ) {}

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    // If circuit is open, check if recovery time has passed
    if (this.state === 'open') {
      const now = Date.now();
      if (now - this.lastFailureTime > this.recoveryTimeMs) {
        this.state = 'half-open';
        this.successes = 0;
      } else {
        throw new SupaclawError(
          'Circuit breaker is open',
          'CIRCUIT_BREAKER_OPEN',
          { failures: this.failures, lastFailureTime: this.lastFailureTime }
        );
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failures = 0;
    
    if (this.state === 'half-open') {
      this.successes++;
      if (this.successes >= this.successThreshold) {
        this.state = 'closed';
        this.successes = 0;
      }
    }
  }

  private onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    
    if (this.failures >= this.failureThreshold) {
      this.state = 'open';
    }
  }

  reset() {
    this.failures = 0;
    this.successes = 0;
    this.lastFailureTime = 0;
    this.state = 'closed';
  }

  getState() {
    return {
      state: this.state,
      failures: this.failures,
      successes: this.successes,
      lastFailureTime: this.lastFailureTime,
    };
  }
}

/**
 * Wrap database operations with error handling
 */
export function wrapDatabaseOperation<T>(
  operation: () => Promise<T>,
  errorContext: string
): Promise<T> {
  return retry(
    async () => {
      try {
        return await operation();
      } catch (error: unknown) {
        throw new DatabaseError(
          `${errorContext}: ${(error as Error).message}`,
          error
        );
      }
    },
    {
      maxAttempts: 3,
      initialDelayMs: 500,
      onRetry: (attempt, error) => {
        console.warn(`Retrying ${errorContext} (attempt ${attempt}):`, error.message);
      },
    }
  );
}

/**
 * Wrap embedding operations with error handling
 */
export function wrapEmbeddingOperation<T>(
  operation: () => Promise<T>,
  errorContext: string
): Promise<T> {
  return retry(
    async () => {
      try {
        return await operation();
      } catch (error: unknown) {
        const err = error as Error;
        
        // Check for rate limit errors
        if (err.message.includes('rate_limit') || err.message.includes('429')) {
          throw new RateLimitError(
            `${errorContext}: Rate limit exceeded`,
            error
          );
        }
        
        throw new EmbeddingError(
          `${errorContext}: ${err.message}`,
          error
        );
      }
    },
    {
      maxAttempts: 3,
      initialDelayMs: 2000, // Longer delay for API rate limits
      backoffMultiplier: 3, // More aggressive backoff
      onRetry: (attempt, error) => {
        console.warn(`Retrying ${errorContext} (attempt ${attempt}):`, error.message);
      },
    }
  );
}

/**
 * Validate inputs
 */
export function validateInput(condition: boolean, message: string, details?: unknown): void {
  if (!condition) {
    throw new ValidationError(message, details);
  }
}

/**
 * Safe JSON parse
 */
export function safeJsonParse<T>(
  json: string,
  fallback: T
): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Safe async operation with timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = 'Operation timed out'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new SupaclawError(errorMessage, 'TIMEOUT')), timeoutMs)
    ),
  ]);
}

/**
 * Graceful degradation helper
 */
export async function gracefulFallback<T>(
  primary: () => Promise<T>,
  fallback: () => T | Promise<T>,
  errorContext: string
): Promise<T> {
  try {
    return await primary();
  } catch (error) {
    console.warn(`${errorContext} failed, using fallback:`, (error as Error).message);
    return await fallback();
  }
}

/**
 * Batch operation with error handling
 * Continues processing even if some items fail
 */
export async function batchWithErrorHandling<T, R>(
  items: T[],
  operation: (item: T) => Promise<R>,
  options?: {
    continueOnError?: boolean;
    onError?: (item: T, error: Error) => void;
  }
): Promise<Array<{ success: boolean; result?: R; error?: Error; item: T }>> {
  const opts = {
    continueOnError: true,
    onError: () => {},
    ...options,
  };

  const results = await Promise.allSettled(
    items.map(async item => ({
      item,
      result: await operation(item),
    }))
  );

  return results.map((result, index) => {
    const item = items[index];
    
    if (result.status === 'fulfilled') {
      return {
        success: true,
        result: result.value.result,
        item,
      };
    } else {
      const error = result.reason as Error;
      opts.onError(item, error);
      return {
        success: false,
        error,
        item,
      };
    }
  });
}
