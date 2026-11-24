/**
 * Configuração Next.js 16 com Static Export (`output: 'export'`) para publicação
 * contínua no Cloudflare Pages via GitHub Actions.
 *
 * @spec SPEC-18
 * @rnf RNF-21
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  transpilePackages: ['@tradepilot/shared'],
};

export default nextConfig;
