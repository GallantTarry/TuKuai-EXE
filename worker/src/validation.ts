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
    return { ok: false, error: '请求体缺少应用配置信息' };
  }
  const obj = raw as Record<string, unknown>;

  const appName = typeof obj.appName === 'string' ? obj.appName.trim() : '';
  if (!appName || appName.length > 80 || FORBIDDEN_TEXT_RE.test(appName)) {
    return { ok: false, error: '应用名称不能为空、超过 80 字或包含非法字符' };
  }

  const appVersion = typeof obj.appVersion === 'string' ? obj.appVersion.trim() : '';
  if (!VERSION_RE.test(appVersion)) {
    return { ok: false, error: '版本号格式不正确，请使用如 1.0.0 的纯数字版本' };
  }

  const rawPublisher = typeof obj.appPublisher === 'string' ? obj.appPublisher.trim() : '';
  const appPublisher = rawPublisher || 'TuKuai Studio User';
  if (appPublisher.length > 80 || FORBIDDEN_TEXT_RE.test(appPublisher)) {
    return { ok: false, error: '发布者名称过长或包含非法字符' };
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
    return { ok: false, error: '主程序入口必须选择包内有效的 .exe 相对路径' };
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
    return { ok: false, error: `分片列表不完整，预期 ${expectedParts} 片` };
  }

  const byPart = new Map<number, string>();
  for (const item of rawParts) {
    if (!item || typeof item !== 'object') {
      return { ok: false, error: '分片记录格式错误' };
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
      return { ok: false, error: '分片编号或校验标识无效' };
    }
    if (byPart.has(partNumber)) {
      return { ok: false, error: `分片编号重复: ${partNumber}` };
    }
    byPart.set(partNumber, etag);
  }

  if (byPart.size !== expectedParts) {
    return { ok: false, error: '存在缺失的上传分片' };
  }

  const sorted: Array<{ partNumber: number; etag: string }> = [];
  for (let i = 1; i <= expectedParts; i++) {
    sorted.push({ partNumber: i, etag: byPart.get(i)! });
  }
  return { ok: true, parts: sorted };
}
