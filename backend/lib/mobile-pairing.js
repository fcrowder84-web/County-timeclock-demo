'use strict';

const crypto = require('crypto');

function pairingError(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function createMobilePairingStore({
  ttlMs = 5 * 60 * 1000,
  maxAttempts = 8,
  attemptWindowMs = 10 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  const secret = crypto.randomBytes(32);
  const codes = new Map();
  const employeeCodes = new Map();
  const attempts = new Map();

  function normalizeCode(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function digest(code) {
    return crypto.createHmac('sha256', secret).update(code).digest('hex');
  }

  function cleanupExpired() {
    const current = now();
    for (const [hash, record] of codes.entries()) {
      if (record.expires_at <= current) {
        codes.delete(hash);
        if (employeeCodes.get(String(record.employee_id)) === hash) {
          employeeCodes.delete(String(record.employee_id));
        }
      }
    }
    for (const [key, record] of attempts.entries()) {
      if (record.reset_at <= current) attempts.delete(key);
    }
  }

  function recordFailure(key) {
    const current = now();
    const existing = attempts.get(key);
    if (!existing || existing.reset_at <= current) {
      attempts.set(key, { count: 1, reset_at: current + attemptWindowMs });
      return;
    }
    existing.count += 1;
  }

  function checkRateLimit(key) {
    cleanupExpired();
    const record = attempts.get(key);
    if (record && record.count >= maxAttempts) {
      throw pairingError('RATE_LIMIT', 'Too many incorrect code attempts. Try again later.', 429);
    }
  }

  function issue(payload) {
    cleanupExpired();
    const employeeKey = String(payload.employee_id);
    const oldHash = employeeCodes.get(employeeKey) || null;
    if (oldHash) codes.delete(oldHash);

    let code;
    let hash;
    do {
      code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      hash = digest(code);
    } while (codes.has(hash) || hash === oldHash);

    const expiresAt = now() + ttlMs;
    codes.set(hash, { ...payload, expires_at: expiresAt });
    employeeCodes.set(employeeKey, hash);
    return { code, expires_at: expiresAt };
  }

  function redeem(rawCode, attemptKey = 'unknown') {
    const key = String(attemptKey || 'unknown');
    checkRateLimit(key);
    const code = normalizeCode(rawCode);
    if (!/^\d{6}$/.test(code)) {
      recordFailure(key);
      throw pairingError('INVALID_CODE', 'Enter the 6-digit code shown on the desktop.', 400);
    }

    const hash = digest(code);
    const record = codes.get(hash);
    if (!record || record.expires_at <= now()) {
      if (record) {
        codes.delete(hash);
        if (employeeCodes.get(String(record.employee_id)) === hash) employeeCodes.delete(String(record.employee_id));
      }
      recordFailure(key);
      throw pairingError('INVALID_CODE', 'That code is invalid or has expired.', 400);
    }

    codes.delete(hash);
    if (employeeCodes.get(String(record.employee_id)) === hash) employeeCodes.delete(String(record.employee_id));
    attempts.delete(key);
    return { ...record };
  }

  return {
    issue,
    redeem,
    size: () => codes.size,
  };
}

module.exports = { createMobilePairingStore };
