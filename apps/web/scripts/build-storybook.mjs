// Builds Storybook into public/storybook so the web app serves it at
// /storybook (next.config.ts sends /storybook to its index.html). Runs before
// `next build`, so a broken story fails the build. Prod builds leave it out:
// it's for test.paymeback.dev and local only.
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const web = fileURLToPath(new URL('..', import.meta.url));
const out = 'public/storybook';
rmSync(new URL(`../${out}`, import.meta.url), { recursive: true, force: true });

const prod = process.env.NEXT_PUBLIC_APP_ENV?.trim() === 'prod' || process.env.VERCEL_ENV === 'production';
if (prod) {
  console.log('Storybook: prod build, left out.');
} else {
  execFileSync('npx', ['storybook', 'build', '--quiet', '-o', out], { cwd: web, stdio: 'inherit' });
}
