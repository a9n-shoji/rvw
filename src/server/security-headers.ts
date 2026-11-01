import type { MiddlewareHandler } from "hono";

// srcdoc previews inherit this policy and add their own stricter policy.
// Inline styles support React positioning, Mermaid and syntax highlighting.
const viewerContentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const securityHeaders: MiddlewareHandler = async (context, next) => {
  context.header("Content-Security-Policy", viewerContentSecurityPolicy);
  context.header("X-Frame-Options", "DENY");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("Referrer-Policy", "no-referrer");
  await next();
};
