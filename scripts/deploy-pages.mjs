/**
 * Cloudflare Pages deploy — use PAGES_DEPLOY_TOKEN to avoid CI read-only CLOUDFLARE_API_TOKEN override.
 */
import { spawnSync } from 'node:child_process';

const token = process.env.PAGES_DEPLOY_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
if (!token) {
  console.error('Missing PAGES_DEPLOY_TOKEN (recommended) or CLOUDFLARE_API_TOKEN');
  process.exit(1);
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || 'a96bc667b234e3831128e3e481821ff0';
const project = process.env.CF_PAGES_PROJECT || 'trading-strstegy';

const args = [
  'pages', 'deploy', '.',
  `--project-name=${project}`,
  `--account-id=${accountId}`,
  '--commit-dirty=true',
];

const env = { ...process.env, CLOUDFLARE_API_TOKEN: token };
const r = spawnSync('wrangler', args, { stdio: 'inherit', env, shell: true });
process.exit(r.status ?? 1);
