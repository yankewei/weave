import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // node-postgres ships optional native bindings; keep it out of the bundle.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
