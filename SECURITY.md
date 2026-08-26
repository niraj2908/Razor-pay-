# Security

Frozen from Master Specification Section 28.

## Never commit
- Razorpay secrets
- LLM API keys
- Database credentials
- JWT secrets
- Webhook secrets

Use .env.example as the template; real values live only in .env (gitignored).

## Required
- Webhook signature verification on every inbound Razorpay event
- Server-side secrets only -- never shipped to the frontend
- Authentication and authorization on every API boundary
- Merchant tenant isolation (every query scoped by merchantId)
- Input validation at every boundary (Zod or equivalent)
- PII minimization
- Secure logging -- no secrets or full PII in logs
- Audit trails for every automated financial action
- No sensitive data sent to an LLM unless the specific call requires it
