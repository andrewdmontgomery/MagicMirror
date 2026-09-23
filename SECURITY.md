# Security Policy

## Reporting a vulnerability

This is a single-maintainer personal project. Please do **not** open a public
issue for security reports — use GitHub's private
**Security → Report a vulnerability** flow on this repo instead.

## Secrets

`.env` (CARTO API key, etc.) is gitignored and never committed. If you
accidentally commit a secret, rotate it immediately and tell the maintainer
so affected keys can be revoked.
