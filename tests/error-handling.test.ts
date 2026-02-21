/**
 * Tests for error-handling.ts
 * Covers: error classes, retry, CircuitBreaker, helpers
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SupaclawError,
  DatabaseError,
  EmbeddingError,
  ValidationError,
  RateLimitError,
  retry,
  CircuitBreaker,
  wrapDatabaseOperation,
  wrapEmbeddingOperation,
  validateInput,
  safeJsonParse,
  withTimeout,
  gracefulFallback,
  batchWithErrorHandling
} from '../src/error-handling';

// ============ Error Classes ============

describe('SupaclawError', () => {
  it('has correct message, code, name, and details', () => {
    const err = new SupaclawError('test message', 'TEST_CODE', { extra: 'data' });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SupaclawError);
    expect(err.message).toBe('test message');
    expect(err.code).toBe('TEST_CODE');
    expect(err.details).toEqual({ extra: 'data' });
    expect(err.name).toBe('SupaclawError');
  });

  it('works without details', () => {
    const err = new SupaclawError('msg', 'CODE');
    expect(err.details).toBeUndefined();
  });
});

describe('DatabaseError', () => {
  it('extends SupaclawError with DATABASE_ERROR code', () => {
    const err = new DatabaseError('db failed', { table: 'entities' });

    expect(err).toBeInstanceOf(SupaclawError);
    expect(err).toBeInstanceOf(DatabaseError);
    expect(err.code).toBe('DATABASE_ERROR');
    expect(err.name).toBe('DatabaseError');
    expect(err.message).toBe('db failed');
  });
});

describe('EmbeddingError', () => {
  it('extends SupaclawError with EMBEDDING_ERROR code', () => {
    const err = new EmbeddingError('embedding failed');

    expect(err).toBeInstanceOf(SupaclawError);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect(err.code).toBe('EMBEDDING_ERROR');
    expect(err.name).toBe('EmbeddingError');
  });
});

describe('ValidationError', () => {
  it('extends SupaclawError with VALIDATION_ERROR code', () => {
    const err = new ValidationError('invalid input');

    expect(err).toBeInstanceOf(SupaclawError);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.code).toBe('VALIDATION_ERROR');
    expect(err.name).toBe('ValidationError');
  });
});

describe('RateLimitError', () => {
  it('extends SupaclawError with RATE_LIMIT_ERROR code', () => {
    const err = new RateLimitError('too many requests');

    expect(err).toBeInstanceOf(SupaclawError);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.code).toBe('RATE_LIMIT_ERROR');
    expect(err.name).toBe('RateLimitError');
  });
});

// ============ retry() ============

describe('retry()', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('succeeds on first try without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('result');

    const result = await retry(fn, { maxAttempts: 3 });

    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('succeeds on second try after transient failure', async () => {
    vi.useFakeTimers();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue('success');

    const resultPromise = retry(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
    });

    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('exhausts all attempts and throws the last error', async () => {
    vi.useFakeTimers();
    const err = new RateLimitError('rate limited');
    const fn = vi.fn().mockRejectedValue(err);

    const resultPromise = retry(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      shouldRetry: () => true,
    });

    // Attach rejection handler before running timers to avoid unhandled rejection
    const assertion = expect(resultPromise).rejects.toBe(err);
    await vi.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry non-retryable errors (constraint errors)', async () => {
    const err = new DatabaseError('unique constraint violation');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(retry(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry callback with attempt number and error', async () => {
    vi.useFakeTimers();
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue('ok');

    const p = retry(fn, {
      maxAttempts: 3,
      initialDelayMs: 100,
      onRetry,
    });

    await vi.runAllTimersAsync();
    await p;

    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });
});

// ============ CircuitBreaker ============

describe('CircuitBreaker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts in closed state', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState().state).toBe('closed');
  });

  it('opens after reaching the failure threshold', async () => {
    const cb = new CircuitBreaker(3);
    const failFn = vi.fn().mockRejectedValue(new Error('fail'));

    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(failFn)).rejects.toThrow('fail');
    }

    expect(cb.getState().state).toBe('open');
    expect(cb.getState().failures).toBe(3);
  });

  it('throws CIRCUIT_BREAKER_OPEN when circuit is open', async () => {
    const cb = new CircuitBreaker(1);
    const failFn = vi.fn().mockRejectedValue(new Error('fail'));

    await expect(cb.execute(failFn)).rejects.toThrow('fail');
    expect(cb.getState().state).toBe('open');

    await expect(cb.execute(failFn)).rejects.toMatchObject({
      code: 'CIRCUIT_BREAKER_OPEN'
    });
  });

  it('transitions to half-open after recovery time and allows execution', async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker(1, 1000);

    await expect(
      cb.execute(vi.fn().mockRejectedValue(new Error('fail')))
    ).rejects.toThrow('fail');

    expect(cb.getState().state).toBe('open');

    vi.advanceTimersByTime(1001);

    const result = await cb.execute(vi.fn().mockResolvedValue('ok'));
    expect(result).toBe('ok');
  });

  it('resets to closed after enough successes in half-open', async () => {
    vi.useFakeTimers();
    const cb = new CircuitBreaker(1, 1000, 2); // successThreshold=2

    await expect(
      cb.execute(vi.fn().mockRejectedValue(new Error()))
    ).rejects.toThrow();

    vi.advanceTimersByTime(1001);

    const successFn = vi.fn().mockResolvedValue('ok');
    await cb.execute(successFn); // success 1 in half-open
    await cb.execute(successFn); // success 2 → transitions to closed

    expect(cb.getState().state).toBe('closed');
  });

  it('reset() clears all state back to closed', async () => {
    const cb = new CircuitBreaker(1);
    await expect(
      cb.execute(vi.fn().mockRejectedValue(new Error()))
    ).rejects.toThrow();

    cb.reset();

    expect(cb.getState()).toEqual({
      state: 'closed',
      failures: 0,
      successes: 0,
      lastFailureTime: 0
    });
  });

  it('resets failure count on success', async () => {
    const cb = new CircuitBreaker(5);
    const failFn = vi.fn().mockRejectedValue(new Error('fail'));
    const successFn = vi.fn().mockResolvedValue('ok');

    // Fail twice
    await expect(cb.execute(failFn)).rejects.toThrow();
    await expect(cb.execute(failFn)).rejects.toThrow();

    // Succeed — resets failure count
    await cb.execute(successFn);

    expect(cb.getState().failures).toBe(0);
    expect(cb.getState().state).toBe('closed');
  });
});

// ============ wrapDatabaseOperation() ============

describe('wrapDatabaseOperation()', () => {
  it('returns result when operation succeeds', async () => {
    const op = vi.fn().mockResolvedValue('data');

    const result = await wrapDatabaseOperation(op, 'testOp');

    expect(result).toBe('data');
  });

  it('wraps thrown errors as DatabaseError', async () => {
    const op = vi.fn().mockRejectedValue(new Error('unique constraint violation'));

    await expect(wrapDatabaseOperation(op, 'testOp')).rejects.toMatchObject({
      name: 'DatabaseError',
      code: 'DATABASE_ERROR'
    });
  });
});

// ============ wrapEmbeddingOperation() ============

describe('wrapEmbeddingOperation()', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result when operation succeeds', async () => {
    const op = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);

    const result = await wrapEmbeddingOperation(op, 'embedOp');

    expect(result).toEqual([0.1, 0.2, 0.3]);
  });

  it('wraps generic errors as EmbeddingError', async () => {
    const op = vi.fn().mockRejectedValue(new Error('unique constraint violation'));

    await expect(wrapEmbeddingOperation(op, 'embedOp')).rejects.toMatchObject({
      name: 'EmbeddingError'
    });
  });

  it('wraps rate_limit errors as RateLimitError and retries', async () => {
    vi.useFakeTimers();
    const op = vi.fn().mockRejectedValue(new Error('rate_limit exceeded'));

    const p = wrapEmbeddingOperation(op, 'embedOp');
    // Attach rejection handler before running timers to avoid unhandled rejection
    const assertion = expect(p).rejects.toMatchObject({ name: 'RateLimitError' });
    await vi.runAllTimersAsync();
    await assertion;

    // 3 attempts total (maxAttempts=3)
    expect(op).toHaveBeenCalledTimes(3);
  });
});

// ============ validateInput() ============

describe('validateInput()', () => {
  it('does not throw when condition is true', () => {
    expect(() => validateInput(true, 'should not throw')).not.toThrow();
  });

  it('throws ValidationError when condition is false', () => {
    expect(() => validateInput(false, 'invalid input')).toThrow(ValidationError);
    expect(() => validateInput(false, 'invalid input')).toThrow('invalid input');
  });

  it('includes details in ValidationError', () => {
    try {
      validateInput(false, 'bad value', { field: 'name' });
    } catch (e) {
      expect((e as ValidationError).details).toEqual({ field: 'name' });
    }
  });
});

// ============ safeJsonParse() ============

describe('safeJsonParse()', () => {
  it('parses valid JSON and returns typed result', () => {
    const result = safeJsonParse<{ key: string }>('{"key":"value"}', { key: '' });
    expect(result).toEqual({ key: 'value' });
  });

  it('returns fallback for invalid JSON', () => {
    const result = safeJsonParse('not valid json', null);
    expect(result).toBeNull();
  });

  it('returns typed array fallback on parse failure', () => {
    const result = safeJsonParse<string[]>('broken', []);
    expect(result).toEqual([]);
  });
});

// ============ withTimeout() ============

describe('withTimeout()', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves normally when promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve('done'), 1000);
    expect(result).toBe('done');
  });

  it('rejects with SupaclawError TIMEOUT when deadline exceeded', async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise<string>(() => {});

    const timeoutPromise = withTimeout(neverResolves, 100, 'Custom timeout');
    // Attach rejection handler before running timers to avoid unhandled rejection
    const assertion = expect(timeoutPromise).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'Custom timeout'
    });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('uses default timeout message when none provided', async () => {
    vi.useFakeTimers();
    const neverResolves = new Promise<string>(() => {});

    const timeoutPromise = withTimeout(neverResolves, 50);
    // Attach rejection handler before running timers to avoid unhandled rejection
    const assertion = expect(timeoutPromise).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: 'Operation timed out'
    });
    await vi.runAllTimersAsync();
    await assertion;
  });
});

// ============ gracefulFallback() ============

describe('gracefulFallback()', () => {
  it('returns primary result when primary succeeds', async () => {
    const primary = vi.fn().mockResolvedValue('primary');
    const fallback = vi.fn().mockReturnValue('fallback');

    const result = await gracefulFallback(primary, fallback, 'test');

    expect(result).toBe('primary');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('returns fallback result when primary fails', async () => {
    const primary = vi.fn().mockRejectedValue(new Error('primary failed'));
    const fallback = vi.fn().mockReturnValue('fallback');

    const result = await gracefulFallback(primary, fallback, 'test');

    expect(result).toBe('fallback');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it('supports async fallback', async () => {
    const primary = vi.fn().mockRejectedValue(new Error('fail'));
    const fallback = vi.fn().mockResolvedValue('async-fallback');

    const result = await gracefulFallback(primary, fallback, 'test');

    expect(result).toBe('async-fallback');
  });
});

// ============ batchWithErrorHandling() ============

describe('batchWithErrorHandling()', () => {
  it('processes all items successfully', async () => {
    const items = [1, 2, 3];

    const results = await batchWithErrorHandling(items, async (n) => n * 2);

    expect(results).toHaveLength(3);
    expect(results.every(r => r.success)).toBe(true);
    expect(results.map(r => r.result)).toEqual([2, 4, 6]);
  });

  it('collects errors without stopping other items', async () => {
    const items = [1, 2, 3];

    const results = await batchWithErrorHandling(items, async (n) => {
      if (n === 2) throw new Error('item 2 failed');
      return n * 2;
    });

    expect(results).toHaveLength(3);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[2]!.success).toBe(true);
    expect(results[1]!.error?.message).toBe('item 2 failed');
  });

  it('calls onError callback for each failed item', async () => {
    const onError = vi.fn();
    const items = ['a', 'b', 'c'];

    await batchWithErrorHandling(
      items,
      async (item) => {
        if (item === 'a') throw new Error('a failed');
        return item;
      },
      { onError }
    );

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('a', expect.any(Error));
  });

  it('returns item reference in each result', async () => {
    const items = ['x', 'y'];

    const results = await batchWithErrorHandling(items, async (item) => item.toUpperCase());

    expect(results[0]!.item).toBe('x');
    expect(results[1]!.item).toBe('y');
  });

  it('handles empty item list', async () => {
    const results = await batchWithErrorHandling([], async (n: number) => n);

    expect(results).toHaveLength(0);
  });
});
