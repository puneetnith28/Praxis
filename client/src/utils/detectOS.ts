export type PlatformOS = 'mac-arm' | 'mac-intel' | 'linux' | 'windows' | 'unknown';

/** The three platform buckets a packaged artifact can belong to. */
export type PlatformFamily = 'win' | 'mac' | 'linux';

export interface DetectedPlatform {
  os: PlatformOS;
  /** 'win' | 'mac' | 'linux', or null when the OS could not be identified. */
  family: PlatformFamily | null;
  label: string;
  architecture: string;
}

export function detectUserOS(): DetectedPlatform {
  if (typeof window === 'undefined') {
    return { os: 'unknown', family: null, label: 'Desktop App', architecture: 'Universal' };
  }

  const userAgent = window.navigator.userAgent.toLowerCase();
  const platform =
    (window.navigator as any).userAgentData?.platform?.toLowerCase() ||
    window.navigator.platform.toLowerCase();

  if (platform.includes('mac') || userAgent.includes('macintosh')) {
    const isArm =
      userAgent.includes('arm') ||
      (window.navigator as any).userAgentData?.brands?.some((b: any) => b.brand.includes('Apple'));
    return isArm
      ? { os: 'mac-arm', family: 'mac', label: 'macOS (Apple Silicon)', architecture: 'Apple Silicon (M1/M2/M3/M4)' }
      : { os: 'mac-intel', family: 'mac', label: 'macOS (Intel)', architecture: 'Intel 64-bit' };
  }

  if (platform.includes('win') || userAgent.includes('windows')) {
    return { os: 'windows', family: 'win', label: 'Windows (x64)', architecture: 'Windows 64-bit' };
  }

  if (platform.includes('linux') || userAgent.includes('linux') || userAgent.includes('x11')) {
    return { os: 'linux', family: 'linux', label: 'Linux', architecture: 'Linux x86_64' };
  }

  return { os: 'unknown', family: null, label: 'Download Desktop', architecture: 'Universal' };
}
