import type { BuildMetadata } from './types.ts';

const FORBIDDEN_TEXT_RE = /[\r\n\x00-\x1F"`;\[\]\\/{}$%]/;
const VERSION_RE = /^[0-9]+(\.[0-9]+){1,3}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id: string): boolean {
  return UUID_RE.test(id);
}

/**
 * Validates and normalizes user-submitted installer metadata to block INI injection
 * and invalid version strings before dispatching to the Windows runner.
 */
export function validateBuildMetadata(raw: unknown): { ok: true; value: BuildMetadata } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'Missing application configuration in request body.' };
  }
  const obj = raw as Record<string, unknown>;

  const appName = typeof obj.appName === 'string' ? obj.appName.trim() : '';
  if (!appName || appName.length > 80 || FORBIDDEN_TEXT_RE.test(appName)) {
    return {
      ok: false,
      error: 'Application name must be 1-80 characters and cannot contain forbidden control or INI characters.',
    };
  }

  const appVersion = typeof obj.appVersion === 'string' ? obj.appVersion.trim() : '';
  if (!VERSION_RE.test(appVersion)) {
    return { ok: false, error: 'Invalid version format. Use numeric dot format such as 1.0.0.' };
  }

  const rawPublisher = typeof obj.appPublisher === 'string' ? obj.appPublisher.trim() : '';
  const appPublisher = rawPublisher || 'TuKuai Studio User';
  if (appPublisher.length > 80 || FORBIDDEN_TEXT_RE.test(appPublisher)) {
    return {
      ok: false,
      error: 'Publisher name must be at most 80 characters and cannot contain forbidden characters.',
    };
  }

  const rawMainExe = typeof obj.mainExe === 'string' ? obj.mainExe.trim() : '';
  const mainExe = rawMainExe.replaceAll('/', '\\').replace(/^\\+/, '');
  if (
    !mainExe ||
    mainExe.length > 200 ||
    !mainExe.toLowerCase().endsWith('.exe') ||
    /(^|\\)\.\.(\\|$)/.test(mainExe) ||
    /[\r\n\x00-\x1F"`;\[\]{}$%]/.test(mainExe)
  ) {
    return { ok: false, error: 'Main executable must be a valid relative .exe path inside the archive.' };
  }

  return {
    ok: true,
    value: {
      appName,
      appVersion,
      appPublisher,
      mainExe,
    },
  };
}

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? Math.floor(num) : fallback;
}

export function resolveAllowedOrigin(origin: string | null, allowedListCsv: string): string | null {
  if (!origin) return null;
  const allowed = allowedListCsv
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

/**
 * Constant-time string equality check using UTF-8 byte comparison to avoid
 * timing side channels on job secrets and runner auth tokens.
 */
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= ab[i] ^ bb[i];
  }
  return diff === 0;
}

/**
 * Validates client-supplied multipart part records before completing an R2
 * multipart upload, ensuring complete part coverage 1..expectedParts.
 */
export function validateUploadedParts(
  rawParts: unknown,
  expectedParts: number
): { ok: true; parts: Array<{ partNumber: number; etag: string }> } | { ok: false; error: string } {
  if (!Array.isArray(rawParts) || rawParts.length !== expectedParts || expectedParts <= 0) {
    return { ok: false, error: `Incomplete part list: expected ${expectedParts} parts.` };
  }

  const byPart = new Map<number, string>();
  for (const item of rawParts) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: 'Invalid part record format.' };
    }
    const obj = item as Record<string, unknown>;
    const partNumber = Number(obj.partNumber);
    const etag = typeof obj.etag === 'string' ? obj.etag.trim() : '';
    if (
      !Number.isInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > expectedParts ||
      !etag ||
      etag.length > 128
    ) {
      return { ok: false, error: 'Invalid part number or ETag.' };
    }
    if (byPart.has(partNumber)) {
      return { ok: false, error: `Duplicate part number: ${partNumber}.` };
    }
    byPart.set(partNumber, etag);
  }

  if (byPart.size !== expectedParts) {
    return { ok: false, error: 'Missing uploaded part(s).' };
  }

  const sorted: Array<{ partNumber: number; etag: string }> = [];
  for (let i = 1; i <= expectedParts; i++) {
    sorted.push({ partNumber: i, etag: byPart.get(i)! });
  }
  return { ok: true, parts: sorted };
}

/**
 * Mirrors scripts/build-installer.ps1 slug rules so fallback paths never fall back
 * to internal artifact labels like "installer-<uuid>".
 */
export function deriveExpectedArtifactName(appName: string): string {
  let slug = (appName || '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) slug = 'App';
  if (slug.length > 40) slug = slug.slice(0, 40);
  return `TuKuai-Setup-${slug}-x64.zip`;
}

export type ParsedByteRange =
  | { ok: true; full: boolean; start: number; end: number; length: number }
  | { ok: false; status: 400 | 416 };

/**
 * Parses either query-string chunk offsets (?start=&end=) or standard HTTP Range
 * headers so browser chunked fetch() stays CORS-safelisted while native managers work too.
 */
export function parseByteRange(
  startParam: string | null,
  endParam: string | null,
  rangeHeader: string | null,
  totalSize: number
): ParsedByteRange {
  if (!Number.isInteger(totalSize) || totalSize <= 0) {
    return { ok: false, status: 416 };
  }

  if (startParam !== null || endParam !== null) {
    if (startParam !== null && !/^\d+$/.test(startParam)) {
      return { ok: false, status: 400 };
    }
    if (endParam !== null && !/^\d+$/.test(endParam)) {
      return { ok: false, status: 400 };
    }
    const start = startParam !== null ? Number(startParam) : 0;
    const rawEnd = endParam !== null ? Number(endParam) : totalSize - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(rawEnd) || start < 0) {
      return { ok: false, status: 400 };
    }
    if (start >= totalSize || rawEnd < start) {
      return { ok: false, status: 416 };
    }
    const end = Math.min(rawEnd, totalSize - 1);
    return { ok: true, full: false, start, end, length: end - start + 1 };
  }

  if (rangeHeader) {
    const trimmed = rangeHeader.trim();
    const match = /^bytes=(\d*)-(\d*)$/i.exec(trimmed);
    if (!match) {
      return { ok: true, full: true, start: 0, end: totalSize - 1, length: totalSize };
    }
    const [, rawStart, rawEnd] = match;
    if (!rawStart && !rawEnd) {
      return { ok: false, status: 416 };
    }
    if (!rawStart) {
      const suffix = Number(rawEnd);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) {
        return { ok: false, status: 416 };
      }
      const start = Math.max(0, totalSize - suffix);
      const end = totalSize - 1;
      return { ok: true, full: false, start, end, length: end - start + 1 };
    }
    const start = Number(rawStart);
    const parsedEnd = rawEnd ? Number(rawEnd) : totalSize - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(parsedEnd)) {
      return { ok: false, status: 416 };
    }
    if (start >= totalSize || parsedEnd < start) {
      return { ok: false, status: 416 };
    }
    const end = Math.min(parsedEnd, totalSize - 1);
    return { ok: true, full: false, start, end, length: end - start + 1 };
  }

  return { ok: true, full: true, start: 0, end: totalSize - 1, length: totalSize };
}

export function shouldExpireR2Object(
  uploadedMs: number,
  nowMs: number,
  maxAgeMs: number
): boolean {
  return uploadedMs < nowMs - maxAgeMs;
}
