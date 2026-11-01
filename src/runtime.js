/** Windows paths to WSL files carry the distribution, so never use the default distro for them. */
export function wslLocation(root) {
  const match = String(root).replaceAll('/', '\\').match(/^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(.*)$/i);
  return match ? { distro: match[1], path: match[2].replaceAll('\\', '/') || '/' } : null;
}

export function projectEnvironment(root, platform = process.platform, env = process.env) {
  const location = wslLocation(root);
  if (location) return { runtime: 'wsl', ...location };
  if (platform === 'win32') return { runtime: 'windows', distro: '' };
  return { runtime: 'wsl', distro: env.WSL_DISTRO_NAME || '', native: true };
}

export function cliEnvironment(cfg, name, root = process.cwd()) {
  const project = projectEnvironment(root);
  const runtime = cfg.runtime?.[name] || 'auto';
  if (runtime === 'auto') return { ...project, distro: project.runtime === 'wsl' ? project.distro || cfg.wsl_distro || '' : '' };
  return { runtime, distro: runtime === 'wsl' ? wslLocation(root)?.distro || cfg.wsl_distro || '' : '', native: process.platform !== 'win32' };
}
