/**
 * authMiddleware
 *
 * If SERVICE_API_KEY is set in .env, every request to /api/* must
 * include the header:  X-API-Key: <your_key>
 *
 * If SERVICE_API_KEY is blank, middleware is a no-op (localhost open access).
 */
function authMiddleware(req, res, next) {
  const requiredKey = process.env.SERVICE_API_KEY;

  if (!requiredKey) return next();   // Auth disabled — skip

  const provided = req.headers['x-api-key'];

  if (!provided) {
    return res.status(401).json({
      success: false,
      error: 'Missing X-API-Key header.',
    });
  }

  if (provided !== requiredKey) {
    return res.status(403).json({
      success: false,
      error: 'Invalid API key.',
    });
  }

  next();
}

module.exports = { authMiddleware };
