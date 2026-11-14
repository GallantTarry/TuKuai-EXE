const encoder = new TextEncoder();

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function encodeObjectKey(key: string): string {
  return key.split('/').map(encodeRfc3986).join('/');
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(message));
  return toHex(digest);
}

async function hmacSha256(key: ArrayBuffer | Uint8Array, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
}

function formatAmzDate(date: Date): { amzDate: string; dateStamp: string } {
  const iso = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  };
}

export interface PresignParams {
  method: 'PUT' | 'GET';
  accountId: string;
  bucket: string;
  key: string;
  accessKeyId: string;
  secretAccessKey: string;
  expiresSeconds: number;
  contentType?: string;
  now?: Date;
}

/**
 * Generates an AWS SigV4 presigned URL targeting Cloudflare R2 S3 API
 * using pure WebCrypto (zero runtime dependencies).
 */
export async function presignR2Url(params: PresignParams): Promise<string> {
  const host = `${params.accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodeRfc3986(params.bucket)}/${encodeObjectKey(params.key)}`;
  const { amzDate, dateStamp } = formatAmzDate(params.now ?? new Date());
  const region = 'auto';
  const service = 's3';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const signedHeaders = params.contentType ? 'content-type;host' : 'host';
  const canonicalHeaders = params.contentType
    ? `content-type:${params.contentType}\nhost:${host}\n`
    : `host:${host}\n`;

  // Keys are already in strict ASCII alphabetical order for AWS SigV4.
  const queryPairs: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${params.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(params.expiresSeconds)],
    ['X-Amz-SignedHeaders', signedHeaders],
  ];

  const canonicalQuery = queryPairs
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');

  const canonicalRequest = [
    params.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = await hmacSha256(encoder.encode(`AWS4${params.secretAccessKey}`), dateStamp);
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, service);
  const kSigning = await hmacSha256(kService, 'aws4_request');
  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
