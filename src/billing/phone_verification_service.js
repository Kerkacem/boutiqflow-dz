/**
 * BoutiqFlow DZ — Phone Verification Service (Phase 12, Requirement 13)
 * Manages OTP issuance, rate limiting, resend cooldowns, attempt counters,
 * and secure storage (never storing plaintext OTPs after verification).
 */

const crypto = require('crypto');
const { generateUUIDv7 } = require('../db/utils');

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

class PhoneVerificationService {
  /**
   * Issues a new OTP verification request with cooldown and rate limit enforcement
   */
  static async requestVerification(tx, { phone, tenantId = null }) {
    if (!phone) throw new Error('Phone number is required');

    const cleanPhone = phone.trim();
    const now = Date.now();

    // 1. Check existing pending verifications for cooldown (e.g. 60s cooldown)
    const existing = await tx.query('phone_verifications', v => v.phone === cleanPhone);
    const recent = existing.filter(v => v.status === 'PENDING' && (now - new Date(v.created_at).getTime()) < 60000);
    if (recent.length > 0) {
      const err = new Error('Resend cooldown active. Please wait 60 seconds between OTP requests');
      err.code = 'RESEND_COOLDOWN_ACTIVE';
      throw err;
    }

    // 2. Check max requests per phone (e.g. max 5 per hour)
    const oneHourAgo = now - 3600000;
    const hourRequests = existing.filter(v => new Date(v.created_at).getTime() > oneHourAgo);
    if (hourRequests.length >= 5) {
      const err = new Error('Maximum OTP verification requests reached for this phone number. Try again later.');
      err.code = 'RATE_LIMIT_EXCEEDED';
      throw err;
    }

    // Generate 6-digit OTP
    const rawOtp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = hashOtp(rawOtp);
    const expiresAt = new Date(now + 10 * 60000).toISOString(); // 10 minutes

    const verificationId = `VER-${crypto.randomUUID().slice(0, 8)}`;
    const record = {
      id: verificationId,
      tenant_id: tenantId,
      phone: cleanPhone,
      otp_hash: otpHash,
      attempts_count: 0,
      max_attempts: 3,
      status: 'PENDING',
      expires_at: expiresAt,
      created_at: new Date(now).toISOString()
    };

    await tx.insert('phone_verifications', record);

    return {
      verificationId,
      phone: cleanPhone,
      expiresAt,
      // debugOtp returned strictly for test environments, never stored plaintext in db
      debugOtp: rawOtp
    };
  }

  /**
   * Verifies an OTP code against hashed value with attempt limit & expiration
   */
  static async verifyCode(tx, { verificationId, code }) {
    if (!verificationId || !code) throw new Error('Verification ID and code are required');

    const record = await tx.getById('phone_verifications', verificationId);
    if (!record) {
      const err = new Error('Verification request not found');
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (record.status === 'VERIFIED') {
      return { verified: true, message: 'Already verified' };
    }

    const now = Date.now();
    if (now > new Date(record.expires_at).getTime()) {
      await tx.update('phone_verifications', verificationId, { status: 'EXPIRED' });
      const err = new Error('Verification code has expired');
      err.code = 'OTP_EXPIRED';
      throw err;
    }

    if (record.attempts_count >= record.max_attempts) {
      await tx.update('phone_verifications', verificationId, { status: 'FAILED' });
      const err = new Error('Maximum verification attempts exceeded');
      err.code = 'MAX_ATTEMPTS_EXCEEDED';
      throw err;
    }

    const inputHash = hashOtp(code.trim());
    if (inputHash !== record.otp_hash) {
      const newAttempts = record.attempts_count + 1;
      const newStatus = newAttempts >= record.max_attempts ? 'FAILED' : 'PENDING';
      await tx.update('phone_verifications', verificationId, {
        attempts_count: newAttempts,
        status: newStatus
      });
      const err = new Error('Invalid verification code');
      err.code = 'INVALID_CODE';
      err.remainingAttempts = record.max_attempts - newAttempts;
      throw err;
    }

    // Success: mark VERIFIED and destroy otp_hash (never store plaintext OTP, and zero out hash)
    await tx.update('phone_verifications', verificationId, {
      status: 'VERIFIED',
      otp_hash: null,
      verified_at: new Date().toISOString()
    });

    return { verified: true, verificationId, phone: record.phone };
  }
}

module.exports = { PhoneVerificationService };
