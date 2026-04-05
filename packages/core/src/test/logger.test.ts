import { describe, it, expect, vi, beforeEach } from 'vitest';
import { initLogger, setLogLevel, logger, LogLevel, serializeArg } from '../services/logger';
import { createLoggerService } from '@workcenter/shared';

function createMockChannel() {
  return {
    appendLine: vi.fn(),
    append: vi.fn(),
    clear: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    name: 'WorkCenter',
    replace: vi.fn(),
  };
}

describe('logger', () => {
  let channel: ReturnType<typeof createMockChannel>;

  beforeEach(() => {
    channel = createMockChannel();
    initLogger(channel as any, LogLevel.Debug);
  });

  it('should write info messages to the output channel', () => {
    logger.info('test message');
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
    const line = channel.appendLine.mock.calls[0][0] as string;
    expect(line).toContain('[INFO]');
    expect(line).toContain('test message');
  });

  it('should write debug messages when level is Debug', () => {
    logger.debug('debug message');
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
    const line = channel.appendLine.mock.calls[0][0] as string;
    expect(line).toContain('[DEBUG]');
    expect(line).toContain('debug message');
  });

  it('should write warn messages', () => {
    logger.warn('warn message');
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
    const line = channel.appendLine.mock.calls[0][0] as string;
    expect(line).toContain('[WARN]');
    expect(line).toContain('warn message');
  });

  it('should write error messages', () => {
    logger.error('error message');
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
    const line = channel.appendLine.mock.calls[0][0] as string;
    expect(line).toContain('[ERROR]');
    expect(line).toContain('error message');
  });

  it('should suppress messages below the current log level', () => {
    setLogLevel(LogLevel.Warn);
    logger.debug('hidden debug');
    logger.info('hidden info');
    expect(channel.appendLine).not.toHaveBeenCalled();

    logger.warn('visible warn');
    logger.error('visible error');
    expect(channel.appendLine).toHaveBeenCalledTimes(2);
  });

  it('should include a timestamp in the formatted output', () => {
    logger.info('timestamped');
    const line = channel.appendLine.mock.calls[0][0] as string;
    // ISO timestamp pattern: YYYY-MM-DDTHH:MM:SS
    expect(line).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it('should format extra arguments as JSON', () => {
    logger.info('with args', { key: 'value' }, 42);
    const line = channel.appendLine.mock.calls[0][0] as string;
    expect(line).toContain('{"key":"value"}');
    expect(line).toContain('42');
  });

  it('should respect setLogLevel changes', () => {
    setLogLevel(LogLevel.Error);
    logger.info('should not appear');
    expect(channel.appendLine).not.toHaveBeenCalled();

    logger.error('should appear');
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
  });

  it('should not include extra args section when none provided', () => {
    logger.info('no args');
    const line = channel.appendLine.mock.calls[0][0] as string;
    expect(line).toMatch(/\[INFO\] no args$/);
  });

  it('should serialize Error objects with message and stack', () => {
    const err = new Error('something broke');
    logger.error('failure', err);

    expect(channel.appendLine).toHaveBeenCalledTimes(1);
    const line = channel.appendLine.mock.calls[0][0] as string;
    expect(line).toContain('something broke');
    expect(line).toContain('Error');
  });

  it('should not crash on circular references', () => {
    const obj: any = { a: 1 };
    obj.self = obj;

    expect(() => logger.info('circular', obj)).not.toThrow();
    expect(channel.appendLine).toHaveBeenCalledTimes(1);
  });

  describe('serializeArg', () => {
    it('should return stack for Error with stack', () => {
      const err = new Error('test');
      const result = serializeArg(err);
      expect(result).toContain('Error: test');
    });

    it('should return name+message for Error without stack', () => {
      const err = new Error('no stack');
      err.stack = undefined;
      const result = serializeArg(err);
      expect(result).toBe('Error: no stack');
    });

    it('should JSON.stringify plain objects', () => {
      expect(serializeArg({ key: 'val' })).toBe('{"key":"val"}');
    });

    it('should fall back to String() for circular references', () => {
      const obj: any = {};
      obj.self = obj;
      const result = serializeArg(obj);
      expect(result).toBe('[object Object]');
    });

    // --- Edge case tests ---

    describe('circular references', () => {
      it('should handle deeply nested circular references', () => {
        const obj: any = { a: { b: { c: {} } } };
        obj.a.b.c.root = obj;
        expect(() => serializeArg(obj)).not.toThrow();
        expect(serializeArg(obj)).toBe('[object Object]');
      });

      it('should handle circular arrays', () => {
        const arr: any[] = [1, 2];
        arr.push(arr);
        expect(() => serializeArg(arr)).not.toThrow();
      });

      it('should handle mutually circular objects', () => {
        const a: any = {};
        const b: any = {};
        a.ref = b;
        b.ref = a;
        expect(() => serializeArg(a)).not.toThrow();
      });
    });

    describe('large objects', () => {
      it('should handle deeply nested objects', () => {
        let obj: any = { value: 'leaf' };
        for (let i = 0; i < 100; i++) {
          obj = { nested: obj };
        }
        const result = serializeArg(obj);
        expect(result).toContain('leaf');
      });

      it('should handle objects with many properties', () => {
        const obj: Record<string, number> = {};
        for (let i = 0; i < 1000; i++) {
          obj[`key_${i}`] = i;
        }
        const result = serializeArg(obj);
        expect(result).toContain('key_0');
        expect(result).toContain('key_999');
      });

      it('should handle large arrays', () => {
        const arr = Array.from({ length: 1000 }, (_, i) => i);
        const result = serializeArg(arr);
        expect(result).toContain('999');
      });
    });

    describe('primitive edge cases', () => {
      it('should serialize undefined', () => {
        const result = serializeArg(undefined);
        expect(result).toBe('undefined');
      });

      it('should serialize null', () => {
        expect(serializeArg(null)).toBe('null');
      });

      it('should serialize NaN', () => {
        const result = serializeArg(NaN);
        expect(result).toBe('null');
      });

      it('should serialize Infinity', () => {
        const result = serializeArg(Infinity);
        expect(result).toBe('null');
      });

      it('should serialize -Infinity', () => {
        const result = serializeArg(-Infinity);
        expect(result).toBe('null');
      });

      it('should serialize 0 and -0', () => {
        expect(serializeArg(0)).toBe('0');
        expect(serializeArg(-0)).toBe('0');
      });

      it('should serialize boolean values', () => {
        expect(serializeArg(true)).toBe('true');
        expect(serializeArg(false)).toBe('false');
      });
    });

    describe('Error objects', () => {
      it('should handle Error subclass with stack', () => {
        const err = new TypeError('bad type');
        const result = serializeArg(err);
        expect(result).toContain('TypeError');
        expect(result).toContain('bad type');
      });

      it('should handle RangeError', () => {
        const err = new RangeError('out of range');
        const result = serializeArg(err);
        expect(result).toContain('RangeError');
        expect(result).toContain('out of range');
      });

      it('should handle Error with custom properties', () => {
        const err = new Error('custom');
        (err as any).code = 'ERR_CUSTOM';
        const result = serializeArg(err);
        expect(result).toContain('custom');
      });

      it('should handle Error with empty message', () => {
        const err = new Error('');
        const result = serializeArg(err);
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      });
    });

    describe('functions', () => {
      it('should serialize a named function via String() fallback', () => {
        function myFunc() { return 42; }
        const result = serializeArg(myFunc);
        // JSON.stringify returns undefined for functions, so String(arg) is used
        expect(result).toContain('myFunc');
      });

      it('should serialize an arrow function via String() fallback', () => {
        const fn = () => 'hello';
        const result = serializeArg(fn);
        expect(result).toContain('=>');
      });
    });

    describe('symbols', () => {
      it('should serialize a symbol', () => {
        const sym = Symbol('test');
        const result = serializeArg(sym);
        expect(result).toContain('Symbol');
      });

      it('should serialize Symbol.iterator', () => {
        const result = serializeArg(Symbol.iterator);
        expect(result).toContain('Symbol');
      });
    });

    describe('empty values', () => {
      it('should serialize empty string', () => {
        expect(serializeArg('')).toBe('""');
      });

      it('should serialize empty array', () => {
        expect(serializeArg([])).toBe('[]');
      });

      it('should serialize empty object', () => {
        expect(serializeArg({})).toBe('{}');
      });
    });

    describe('Date objects', () => {
      it('should serialize a Date to its ISO string JSON', () => {
        const d = new Date('2025-01-15T10:30:00.000Z');
        const result = serializeArg(d);
        expect(result).toBe('"2025-01-15T10:30:00.000Z"');
      });

      it('should serialize an invalid Date', () => {
        const d = new Date('invalid');
        const result = serializeArg(d);
        expect(result).toBe('null');
      });
    });

    describe('objects with toJSON', () => {
      it('should use toJSON when available', () => {
        const obj = { toJSON: () => 'custom-json' };
        expect(serializeArg(obj)).toBe('"custom-json"');
      });
    });

    describe('RegExp objects', () => {
      it('should serialize a RegExp', () => {
        const result = serializeArg(/test/gi);
        expect(result).toBe('{}');
      });
    });

    describe('Map and Set', () => {
      it('should serialize a Map (as empty object via JSON.stringify)', () => {
        const map = new Map([['key', 'value']]);
        const result = serializeArg(map);
        expect(result).toBe('{}');
      });

      it('should serialize a Set (as empty object via JSON.stringify)', () => {
        const set = new Set([1, 2, 3]);
        const result = serializeArg(set);
        expect(result).toBe('{}');
      });
    });

    describe('BigInt', () => {
      it('should fall back to String() for BigInt values', () => {
        const result = serializeArg(BigInt(12345));
        expect(result).toBe('12345');
      });
    });

    describe('mixed nested types', () => {
      it('should handle objects with undefined values (omitted by JSON)', () => {
        const obj = { a: 1, b: undefined, c: 'hello' };
        const result = serializeArg(obj);
        expect(result).toBe('{"a":1,"c":"hello"}');
      });

      it('should handle arrays with null holes', () => {
        const arr = [1, null, 3];
        const result = serializeArg(arr);
        expect(result).toBe('[1,null,3]');
      });

      it('should handle nested objects with functions (omitted by JSON)', () => {
        const obj = { a: 1, fn: () => {}, b: 2 };
        const result = serializeArg(obj);
        expect(result).toBe('{"a":1,"b":2}');
      });
    });
  });

  describe('logger with edge case arguments', () => {
    it('should handle multiple edge-case args in one call', () => {
      expect(() => {
        logger.info('edge cases', null, undefined, NaN, Infinity);
      }).not.toThrow();
      expect(channel.appendLine).toHaveBeenCalledTimes(1);
      const line = channel.appendLine.mock.calls[0][0] as string;
      expect(line).toContain('null');
      expect(line).toContain('undefined');
    });

    it('should handle symbol args without crashing', () => {
      expect(() => logger.info('sym', Symbol('x'))).not.toThrow();
      expect(channel.appendLine).toHaveBeenCalledTimes(1);
    });

    it('should handle BigInt args without crashing', () => {
      expect(() => logger.info('big', BigInt(99))).not.toThrow();
      expect(channel.appendLine).toHaveBeenCalledTimes(1);
    });

    it('should handle Error arg alongside other args', () => {
      const err = new Error('oops');
      expect(() => logger.warn('problem', err, { context: 'test' })).not.toThrow();
      expect(channel.appendLine).toHaveBeenCalledTimes(1);
      const line = channel.appendLine.mock.calls[0][0] as string;
      expect(line).toContain('oops');
      expect(line).toContain('context');
    });

    it('should handle function arg', () => {
      expect(() => logger.debug('fn', () => 42)).not.toThrow();
      expect(channel.appendLine).toHaveBeenCalledTimes(1);
    });

    it('should not crash when output channel is not initialized', () => {
      const { logger: freshLogger } = createLoggerService();
      expect(() => freshLogger.info('no channel')).not.toThrow();
    });
  });
});
