/**
 * Input boundary validation middleware: bad input -> clean 4xx, never 500
 */
function validateTenant(req, res, next) {
  const tenantId = req.headers['x-tenant-id'] || req.query.tenant_id || req.body?.tenant_id;
  if (!tenantId || typeof tenantId !== 'string' || tenantId.trim() === '') {
    return res.status(400).json({
      error: 'invalid_request',
      message: "Missing or invalid 'x-tenant-id' header or 'tenant_id' parameter.",
    });
  }
  req.tenantId = tenantId.trim();
  next();
}

function validateGenerateRequest(req, res, next) {
  // If simulate_tokens is passed, validate fields are non-negative numbers
  if (req.body && req.body.simulate_tokens) {
    const { cached_input_tokens, fresh_input_tokens, output_tokens, reasoning_tokens } = req.body.simulate_tokens;

    for (const [key, val] of Object.entries({ cached_input_tokens, fresh_input_tokens, output_tokens, reasoning_tokens })) {
      if (val !== undefined && (typeof val !== 'number' || val < 0 || !Number.isInteger(val))) {
        return res.status(400).json({
          error: 'invalid_request',
          message: `Field 'simulate_tokens.${key}' must be a non-negative integer.`,
        });
      }
    }
  }

  next();
}

module.exports = {
  validateTenant,
  validateGenerateRequest,
};
