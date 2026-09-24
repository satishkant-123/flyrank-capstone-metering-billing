/**
 * Centralized error handler ensuring clean 4xx/5xx responses and zero secret leakage.
 */
function errorHandler(err, req, res, next) {
  // Never log secrets or tokens
  console.error('[Error]', {
    path: req.path,
    method: req.method,
    message: err.message,
    type: err.type || err.name,
  });

  if (err.type === 'StripeSignatureVerificationError' || err.name === 'StripeSignatureVerificationError') {
    return res.status(400).json({
      error: 'invalid_signature',
      message: 'Cryptographic webhook signature verification failed.',
    });
  }

  // Syntax error from express body-parser
  if (err.type === 'entity.parse.failed' || (err instanceof SyntaxError && (err.status === 400 || err.statusCode === 400))) {
    return res.status(400).json({
      error: 'invalid_json',
      message: 'The request body could not be parsed as valid JSON.',
    });
  }

  if (err.status && err.status < 500) {
    return res.status(err.status).json({
      error: err.code || 'bad_request',
      message: err.message,
    });
  }

  if (err.statusCode && err.statusCode < 500) {
    return res.status(err.statusCode).json({
      error: err.code || 'bad_request',
      message: err.message,
    });
  }

  return res.status(500).json({
    error: 'internal_server_error',
    message: 'An unexpected internal server error occurred.',
  });
}

module.exports = errorHandler;
