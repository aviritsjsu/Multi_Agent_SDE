/**
 * Rate Limiting Middleware
 * Protects API endpoints from abuse
 */

import rateLimit from 'express-rate-limit';
import { RATE_LIMITS, HTTP_STATUS } from '../constants.js';

/**
 * General API rate limiter
 */
export const apiLimiter = rateLimit({
  windowMs: RATE_LIMITS.API.WINDOW_MS,
  max: RATE_LIMITS.API.MAX_REQUESTS,
  validate: { trustProxy: false }, // Allow trust proxy in Cloud Run
  message: {
    error: 'Too many requests from this IP',
    message: `Please try again after ${RATE_LIMITS.API.WINDOW_MS / 60000} minutes`,
    retryAfter: RATE_LIMITS.API.WINDOW_MS / 1000,
  },
  statusCode: HTTP_STATUS.RATE_LIMIT,
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  handler: (req, res) => {
    console.warn(`⚠️ Rate limit exceeded for IP: ${req.ip} on ${req.path}`);
    res.status(HTTP_STATUS.RATE_LIMIT).json({
      error: 'Rate limit exceeded',
      message: `Too many requests. Please try again after ${RATE_LIMITS.API.WINDOW_MS / 60000} minutes`,
      retryAfter: RATE_LIMITS.API.WINDOW_MS / 1000,
    });
  },
  skip: (req) => {
    // Skip rate limiting for health checks and frequent polling endpoints
    return req.path === '/api/health' ||
      req.path === '/healthz' ||
      req.path.includes('/memory/sessions') ||
      req.path.includes('/memory/stats');
  },
});

/**
 * ADK pipeline rate limiter (more restrictive)
 */
export const adkLimiter = rateLimit({
  windowMs: RATE_LIMITS.ADK.WINDOW_MS,
  max: RATE_LIMITS.ADK.MAX_REQUESTS,
  validate: { trustProxy: false }, // Allow trust proxy in Cloud Run
  message: {
    error: 'ADK rate limit exceeded',
    message: `ADK operations are expensive. Please try again after ${RATE_LIMITS.ADK.WINDOW_MS / 3600000} hour(s)`,
    retryAfter: RATE_LIMITS.ADK.WINDOW_MS / 1000,
  },
  statusCode: HTTP_STATUS.RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`⚠️ ADK rate limit exceeded for IP: ${req.ip}`);
    res.status(HTTP_STATUS.RATE_LIMIT).json({
      error: 'ADK rate limit exceeded',
      message: `Too many ADK requests. Limit: ${RATE_LIMITS.ADK.MAX_REQUESTS} per ${RATE_LIMITS.ADK.WINDOW_MS / 3600000} hour(s)`,
      retryAfter: RATE_LIMITS.ADK.WINDOW_MS / 1000,
      limit: RATE_LIMITS.ADK.MAX_REQUESTS,
      window: RATE_LIMITS.ADK.WINDOW_MS,
    });
  },
  // Use a unique key for ADK to track separately
  keyGenerator: (req) => {
    // Combine IP with user ID if available for more granular control
    const userId = req.body?.userId || req.query?.userId || 'anonymous';
    return `adk:${req.ip}:${userId}`;
  },
});

/**
 * Chat rate limiter
 */
export const chatLimiter = rateLimit({
  windowMs: RATE_LIMITS.CHAT.WINDOW_MS,
  max: RATE_LIMITS.CHAT.MAX_REQUESTS,
  validate: { trustProxy: false }, // Allow trust proxy in Cloud Run
  message: {
    error: 'Chat rate limit exceeded',
    message: `Too many chat messages. Please try again after ${RATE_LIMITS.CHAT.WINDOW_MS / 60000} minute(s)`,
    retryAfter: RATE_LIMITS.CHAT.WINDOW_MS / 1000,
  },
  statusCode: HTTP_STATUS.RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn(`⚠️ Chat rate limit exceeded for IP: ${req.ip}`);
    res.status(HTTP_STATUS.RATE_LIMIT).json({
      error: 'Chat rate limit exceeded',
      message: `Too many chat requests. Limit: ${RATE_LIMITS.CHAT.MAX_REQUESTS} per ${RATE_LIMITS.CHAT.WINDOW_MS / 60000} minute(s)`,
      retryAfter: RATE_LIMITS.CHAT.WINDOW_MS / 1000,
    });
  },
});

/**
 * Create a custom rate limiter with specific configuration
 * @param {Object} config - Rate limit configuration
 * @returns {Function} Express middleware
 */
export function createRateLimiter(config) {
  const {
    windowMs,
    max,
    message = 'Rate limit exceeded',
    keyGenerator = null,
    skip = null,
  } = config;

  return rateLimit({
    windowMs,
    max,
    validate: { trustProxy: false }, // Allow trust proxy in Cloud Run
    message: {
      error: 'Rate limit exceeded',
      message,
      retryAfter: windowMs / 1000,
    },
    statusCode: HTTP_STATUS.RATE_LIMIT,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    skip,
    handler: (req, res) => {
      console.warn(`⚠️  Custom rate limit exceeded for IP: ${req.ip} on ${req.path}`);
      res.status(HTTP_STATUS.RATE_LIMIT).json({
        error: 'Rate limit exceeded',
        message,
        retryAfter: windowMs / 1000,
      });
    },
  });
}

/**
 * Rate limit info middleware - adds current rate limit status to response headers
 */
export function rateLimitInfo(req, res, next) {
  // This is automatically handled by express-rate-limit with standardHeaders: true
  // Headers added:
  // - RateLimit-Limit: Maximum number of requests
  // - RateLimit-Remaining: Number of requests remaining
  // - RateLimit-Reset: Time when the rate limit resets (Unix timestamp)
  next();
}

/**
 * Skip rate limiting for specific conditions
 */
export function skipRateLimitFor(conditions) {
  return (req) => {
    // Skip for whitelisted IPs
    if (conditions.whitelistIPs && conditions.whitelistIPs.includes(req.ip)) {
      return true;
    }

    // Skip for specific user agents (e.g., monitoring tools)
    if (conditions.whitelistUserAgents) {
      const userAgent = req.get('User-Agent') || '';
      for (const agent of conditions.whitelistUserAgents) {
        if (userAgent.includes(agent)) {
          return true;
        }
      }
    }

    // Skip for specific paths
    if (conditions.skipPaths && conditions.skipPaths.includes(req.path)) {
      return true;
    }

    return false;
  };
}

export default {
  apiLimiter,
  adkLimiter,
  chatLimiter,
  createRateLimiter,
  rateLimitInfo,
  skipRateLimitFor,
};
