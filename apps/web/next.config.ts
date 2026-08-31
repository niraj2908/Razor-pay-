import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfkit (via pdfmake, used by the Reports PDF export route) loads its
  // standard-font metrics (.afm files) from disk at runtime using
  // __dirname-relative paths. Turbopack's bundler rewrites those paths when
  // it inlines the package into a route's compiled chunk, which breaks the
  // lookup (ENOENT for a path under a virtualized "/ROOT/..." prefix).
  // Marking both packages external tells Next to load them via a normal,
  // unbundled require() from node_modules instead, where their real
  // filesystem-relative file reads work as pdfkit expects.
  serverExternalPackages: ["pdfmake", "pdfkit"],
};

export default nextConfig;
