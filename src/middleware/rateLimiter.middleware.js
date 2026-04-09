const rateLimit = require('express-rate-limit');

/**
 * Protects the service from being hammered — important because
 * Instagram soft-blocks IPs that make too many requests.
 *
 * 30 requests per minute per IP is a safe default for a single-user
 * localhost service. Adjust as needed.
 */
const rateLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many requests — slow down to avoid Instagram IP blocks.',
  },
});

module.exports = rateLimiter;
