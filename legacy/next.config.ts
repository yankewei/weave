import { fileURLToPath } from 'node:url';
import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

// The repository root holds the .env shared with docker compose.
loadEnvConfig(fileURLToPath(new URL('..', import.meta.url)));

const nextConfig: NextConfig = {
  // node-postgres ships optional native bindings; keep it out of the bundle.
  serverExternalPackages: ['pg'],
  // The Docker image runs the standalone server without node_modules.
  output: 'standalone',
  outputFileTracingRoot: fileURLToPath(new URL('..', import.meta.url)),
};

export default nextConfig;
