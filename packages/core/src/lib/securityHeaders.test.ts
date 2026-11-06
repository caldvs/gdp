import { describe, it, expect } from 'vitest';
import { contentSecurityPolicy, securityHeaders } from './securityHeaders';

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split('; ').map((d) => {
      const [name, ...values] = d.split(' ');
      return [name!, values];
    }),
  );
}

describe('contentSecurityPolicy', () => {
  it('lets a deployed build reach its API, S3, Stripe and analytics, and nothing local', () => {
    const csp = directives(
      contentSecurityPolicy({
        NEXT_PUBLIC_APP_ENV: 'prod',
        NEXT_PUBLIC_API_BASE_URL: 'https://abc123.execute-api.eu-west-2.amazonaws.com/',
        NODE_ENV: 'production',
        VERCEL_ENV: 'production',
      }),
    );
    const connect = csp.get('connect-src')!;
    expect(connect).toContain('https://abc123.execute-api.eu-west-2.amazonaws.com');
    expect(connect).toContain('https://api.paymeback.dev');
    expect(connect).toContain('https://*.s3.eu-west-2.amazonaws.com');
    expect(connect).toContain('https://*.stripe.com');
    expect(connect.some((o) => o.includes('localhost'))).toBe(false);
    expect(connect).not.toContain('ws:');
    expect(csp.get('script-src')).toContain('https://js.stripe.com');
    expect(csp.get('script-src')).not.toContain('https://vercel.live');
    expect(csp.get('frame-src')).toContain('https://js.stripe.com');
    expect(csp.get('frame-ancestors')).toEqual(["'none'"]);
    expect(csp.get('object-src')).toEqual(["'none'"]);
    expect(csp.has('upgrade-insecure-requests')).toBe(true);
  });

  it('allows the local API and MinIO only in local builds', () => {
    const csp = directives(contentSecurityPolicy({ NODE_ENV: 'production' }));
    expect(csp.get('connect-src')).toContain('http://localhost:3000');
    expect(csp.get('connect-src')).toContain('http://localhost:9000');
    expect(csp.get('img-src')).toContain('http://localhost:9000');
    expect(csp.has('upgrade-insecure-requests')).toBe(false);
  });

  it('adds the dev server socket and the Preview toolbar where they run', () => {
    expect(directives(contentSecurityPolicy({ NODE_ENV: 'development' })).get('connect-src')).toContain('ws:');
    const preview = directives(
      contentSecurityPolicy({ NEXT_PUBLIC_APP_ENV: 'dev', VERCEL_ENV: 'preview', NEXT_PUBLIC_API_BASE_URL: 'https://api.test.paymeback.dev' }),
    );
    expect(preview.get('script-src')).toContain('https://vercel.live');
    expect(preview.get('frame-src')).toContain('https://vercel.live');
  });

  it("keeps 'unsafe-eval': without it the HEIC converter is blocked (checked in Playwright)", () => {
    expect(directives(contentSecurityPolicy({})).get('script-src')).toContain("'unsafe-eval'");
  });

  it('ignores an API URL it cannot parse', () => {
    const csp = directives(contentSecurityPolicy({ NEXT_PUBLIC_API_BASE_URL: 'not a url' }));
    expect(csp.get('connect-src')).not.toContain('not');
  });
});

describe('securityHeaders', () => {
  it('denies framing and sniffing, sends no referrer, and allows only camera and location', () => {
    const h = Object.fromEntries(securityHeaders({}).map(({ key, value }) => [key, value]));
    expect(h['X-Frame-Options']).toBe('DENY');
    expect(h['X-Content-Type-Options']).toBe('nosniff');
    expect(h['Referrer-Policy']).toBe('no-referrer');
    expect(h['Permissions-Policy']).toBe('camera=(self), microphone=(), geolocation=(self)');
    expect(h['Content-Security-Policy']).toContain("default-src 'self'");
  });

  it('lets Storybook frame itself, and only itself', () => {
    const env = { NEXT_PUBLIC_APP_ENV: 'dev', NODE_ENV: 'production' };
    const csp = directives(contentSecurityPolicy(env, { sameOriginFrames: true }));
    expect(csp.get('frame-ancestors')).toEqual(["'self'"]);
    expect(csp.get('frame-src')).toContain("'self'");
    expect(directives(contentSecurityPolicy(env)).get('frame-src')).not.toContain("'self'");
    const xfo = (o?: { sameOriginFrames: boolean }) => securityHeaders(env, o).find((h) => h.key === 'X-Frame-Options')?.value;
    expect(xfo({ sameOriginFrames: true })).toBe('SAMEORIGIN');
    expect(xfo()).toBe('DENY');
  });
});
