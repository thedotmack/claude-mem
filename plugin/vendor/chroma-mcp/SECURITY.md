# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability within Chroma MCP, please send an email to [your-email]. All security vulnerabilities will be promptly addressed.

Please do not publicly disclose the issue until it has been addressed by the maintainers.

## Security Considerations

1. **API Keys and Credentials**: Never commit API keys, credentials, or sensitive configuration to version control. Use environment variables or `.env` files.

2. **SSL/TLS**: When using HTTP or cloud clients, SSL is strongly recommended. For cloud clients, SSL is enforced.

3. **Authentication**: When using HTTP clients, consider using authentication credentials to secure your Chroma instance.

4. **Environment Variables**: Sensitive configuration should be passed via environment variables rather than command line arguments to prevent exposure in process listings. 