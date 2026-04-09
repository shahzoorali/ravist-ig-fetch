/**
 * Global error handler.
 * Catches anything passed via next(err) and returns a clean JSON response.
 */
function errorHandler(err, _req, res, _next) {
  console.error('[error]', err.message, err.details ?? '');

  const status = err.statusCode ?? err.status ?? 500;

  res.status(status).json({
    success: false,
    error: err.message ?? 'Internal server error',
    ...(err.details ? { details: err.details } : {}),
  });
}

module.exports = { errorHandler };
