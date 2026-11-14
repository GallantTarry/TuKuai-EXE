import { presignR2Url } from './sigv4.ts';
import type { Env, JobRecord, MultipartTrackerRecord, ReservationRecord } from './types.ts';
import {
  deriveExpectedArtifactName,
  isValidUuid,
  parsePositiveInt,
  resolveAllowedOrigin,
  safeEqual,
  shouldExpireR2Object,
  validateBuildMetadata,
  validateUploadedParts,
} from './validation.ts';

const RESERVATION_PREFIX = 'res:';
const JOB_PREFIX = 'job:';
const MPU_PREFIX = 'mpu:';
const RESERVATION_TTL_SEC = 360;
const MPU_TTL_SEC = 3600;
const JOB_TTL_SEC = 86400;
const ORPHAN_MAX_AGE_MS = 30 * 60 * 1000;
const PUT_CONTENT_TYPE = 'application/octet-stream';
const ARTIFACT_ZIP_CONTENT_TYPE = 'application/zip';
const EXPOSED_DOWNLOAD_HEADERS =
  'content-length, content-range, accept-ranges, content-disposition, x-artifact-source';
// 8 MiB satisfies R2's 5 MiB minimum part rule while staying well under Cloudflare Free's 100 MB limit.
const UPLOAD_PART_BYTES = 8 * 1024 * 1024;

class BodyLimitError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

async function writeR2FromRequest<T>(
  request: Request,
  maxBytes: number,
  writer: (payload: ReadableStream | ArrayBuffer) => Promise<T>
): Promise<T> {
  if (!request.body) {
    throw new BodyLimitError(400, '请求体为空，未收到上传数据');
  }

  const lenHeader = request.headers.get('content-length');
  if (lenHeader !== null) {
    const declaredLen = Number(lenHeader);
    if (!Number.isInteger(declaredLen) || declaredLen <= 0 || declaredLen > maxBytes) {
      throw new BodyLimitError(413, '上传数据块大小超出允许范围');
    }
    try {
      return await writer(request.body);
    } catch (err) {
      if (err instanceof TypeError && !request.bodyUsed) {
        const buf = await request.arrayBuffer();
        if (buf.byteLength <= 0 || buf.byteLength > maxBytes) {
          throw new BodyLimitError(413, '上传数据块大小超出允许范围');
        }
        return await writer(buf);
      }
      throw err;
    }
  }

  const buf = await request.arrayBuffer();
  if (buf.byteLength <= 0 || buf.byteLength > maxBytes) {
    throw new BodyLimitError(413, '上传数据块大小超出允许范围');
  }
  return await writer(buf);
}

function jsonResponse(
  body: unknown,
  status = 200,
  corsOrigin: string | null = null
): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };
  if (corsOrigin) {
    headers['access-control-allow-origin'] = corsOrigin;
    headers['vary'] = 'Origin';
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function handleCorsPreflight(corsOrigin: string | null): Response {
  if (!corsOrigin) {
    return new Response('Origin not allowed', { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': corsOrigin,
      'access-control-allow-methods': 'GET, HEAD, POST, PUT, OPTIONS',
      'access-control-allow-headers': 'content-type, range, if-range',
      'access-control-max-age': '86400',
      'vary': 'Origin',
    },
  });
}

async function verifyTurnstile(
  secret: string,
  token: string,
  remoteIp: string | null
): Promise<boolean> {
  if (!secret || !token) return false;
  const form = new URLSearchParams();
  form.set('secret', secret);
  form.set('response', token);
  if (remoteIp) form.set('remoteip', remoteIp);

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

async function sha256Short(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest.slice(0, 12)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function checkAndBumpQuotas(
  env: Env,
  clientIp: string
): Promise<{ ok: true } | { ok: false; message: string; status: number }> {
  const ipCap = parsePositiveInt(env.IP_HOURLY_CAP, 5);
  const dailyCap = parsePositiveInt(env.DAILY_JOB_CAP, 120);

  const now = new Date();
  const dayKey = `day:${now.toISOString().slice(0, 10)}`;
  const hourBucket = now.toISOString().slice(0, 13);
  const ipHash = await sha256Short(clientIp);
  const rlKey = `rl:${hourBucket}:${ipHash}`;

  const [dayRaw, ipRaw] = await Promise.all([
    env.JOBS_KV.get(dayKey),
    env.JOBS_KV.get(rlKey),
  ]);

  const dayCount = Number(dayRaw || '0');
  if (dayCount >= dailyCap) {
    return {
      ok: false,
      status: 429,
      message: '今日免费云端打包名额已满，请明日再试。',
    };
  }

  const ipCount = Number(ipRaw || '0');
  if (ipCount >= ipCap) {
    return {
      ok: false,
      status: 429,
      message: `每小时最多提交 ${ipCap} 次打包请求，请稍后再试。`,
    };
  }

  await Promise.all([
    env.JOBS_KV.put(dayKey, String(dayCount + 1), { expirationTtl: 90000 }),
    env.JOBS_KV.put(rlKey, String(ipCount + 1), { expirationTtl: 3900 }),
  ]);

  return { ok: true };
}

/**
 * Sums currently stored R2 bytes plus active upload reservations so concurrent
 * uploads cannot bypass the hard bucket capacity gate.
 */
async function getTotalCommittedBytes(env: Env): Promise<number> {
  let totalBytes = 0;
  let cursor: string | undefined;

  do {
    const listed = await env.BUCKET.list({ cursor, limit: 1000 });
    for (const obj of listed.objects) {
      totalBytes += obj.size;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  let kvCursor: string | undefined;
  do {
    const kvList = await env.JOBS_KV.list({ prefix: RESERVATION_PREFIX, cursor: kvCursor });
    const values = await Promise.all(
      kvList.keys.map((item) => env.JOBS_KV.get<ReservationRecord>(item.name, 'json'))
    );
    for (const rec of values) {
      if (rec && typeof rec.bytes === 'number') {
        totalBytes += rec.bytes;
      }
    }
    kvCursor = kvList.list_complete ? undefined : kvList.cursor;
  } while (kvCursor);

  return totalBytes;
}

async function getJob(env: Env, jobId: string): Promise<JobRecord | null> {
  return env.JOBS_KV.get<JobRecord>(`${JOB_PREFIX}${jobId}`, 'json');
}

async function putJob(env: Env, job: JobRecord): Promise<void> {
  job.updatedAt = Date.now();
  await env.JOBS_KV.put(`${JOB_PREFIX}${job.id}`, JSON.stringify(job), {
    expirationTtl: JOB_TTL_SEC,
  });
}

function githubHeaders(pat: string): Record<string, string> {
  return {
    authorization: `Bearer ${pat}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'TuKuai-EXE-Worker/1.0',
  };
}

async function dispatchGithubBuild(env: Env, jobId: string): Promise<{ runId?: string }> {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/workflows/${env.GITHUB_WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...githubHeaders(env.GITHUB_PAT),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ref: env.GITHUB_REF || 'main',
      return_run_details: true,
      inputs: { job_id: jobId },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub dispatch failed (${res.status}): ${text}`);
  }

  if (res.status === 200) {
    const data = (await res.json()) as { workflow_run_id?: number };
    if (data.workflow_run_id) {
      return { runId: String(data.workflow_run_id) };
    }
  }
  return {};
}

async function syncFallbackFromGithubRun(env: Env, job: JobRecord): Promise<JobRecord> {
  if (!job.runId || job.status === 'succeeded' || job.status === 'failed') {
    return job;
  }
  // Only query GitHub API if the job has been in progress for > 20s to keep API calls frugal.
  if (Date.now() - job.updatedAt < 20_000) {
    return job;
  }

  const runUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs/${job.runId}`;
  const runRes = await fetch(runUrl, { headers: githubHeaders(env.GITHUB_PAT) });
  if (!runRes.ok) return job;

  const runData = (await runRes.json()) as { status?: string; conclusion?: string | null };
  if (runData.status !== 'completed') return job;

  if (runData.conclusion === 'success') {
    const cleanName =
      job.artifactName && !/^installer-[0-9a-f-]{36}$/i.test(job.artifactName)
        ? job.artifactName
        : deriveExpectedArtifactName(job.metadata?.appName || '');

    const artUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/runs/${job.runId}/artifacts`;
    const artRes = await fetch(artUrl, { headers: githubHeaders(env.GITHUB_PAT) });
    if (artRes.ok) {
      const artData = (await artRes.json()) as {
        artifacts?: Array<{ id: number; name: string; expired: boolean }>;
      };
      const valid = artData.artifacts?.find((a) => !a.expired);
      if (valid) {
        job.status = 'succeeded';
        job.artifactId = String(valid.id);
        job.artifactName = cleanName;
        await putJob(env, job);
      }
    }
  } else if (runData.conclusion) {
    job.status = 'failed';
    job.errorMessage = `云端编译未成功 (${runData.conclusion})`;
    if (!job.r2Deleted) {
      await env.BUCKET.delete(job.r2Key);
      job.r2Deleted = true;
    }
    await putJob(env, job);
  }
  return job;
}

function isRunnerAuthorized(request: Request, env: Env): boolean {
  const auth = request.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length).trim();
  return Boolean(env.RUNNER_AUTH_SECRET) && safeEqual(token, env.RUNNER_AUTH_SECRET);
}

async function handleCreateJob(
  request: Request,
  env: Env,
  corsOrigin: string | null
): Promise<Response> {
  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse({ error: 'BAD_JSON', message: '请求体格式错误' }, 400, corsOrigin);
  }

  const maxPkgBytes = parsePositiveInt(env.MAX_PACKAGE_BYTES, 1024 * 1024 * 1024);
  const maxBucketBytes = parsePositiveInt(env.MAX_BUCKET_BYTES, 4 * 1024 * 1024 * 1024);

  const declaredSize = Number(payload.archiveSize);
  if (!Number.isFinite(declaredSize) || declaredSize <= 0 || declaredSize > maxPkgBytes) {
    return jsonResponse(
      {
        error: 'SIZE_LIMIT',
        message: `压缩包大小需在 1 B ~ ${Math.round(maxPkgBytes / 1024 / 1024)} MB 之间`,
      },
      400,
      corsOrigin
    );
  }

  const metaCheck = validateBuildMetadata(payload.metadata);
  if (!metaCheck.ok) {
    return jsonResponse({ error: 'INVALID_METADATA', message: metaCheck.error }, 400, corsOrigin);
  }

  const clientIp = request.headers.get('cf-connecting-ip') || '0.0.0.0';
  const turnstileToken = typeof payload.turnstileToken === 'string' ? payload.turnstileToken : '';
  const turnstileOk = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, turnstileToken, clientIp);
  if (!turnstileOk) {
    return jsonResponse(
      { error: 'TURNSTILE_FAILED', message: '人机验证未通过，请刷新验证后重试' },
      403,
      corsOrigin
    );
  }

  const committedBytes = await getTotalCommittedBytes(env);
  if (committedBytes + declaredSize > maxBucketBytes) {
    return jsonResponse(
      {
        error: 'QUEUE_FULL',
        message: '当前云端中转队列已满，请等待 1~2 分钟后重试',
        committedBytes,
        maxBucketBytes,
      },
      503,
      corsOrigin
    );
  }

  const quota = await checkAndBumpQuotas(env, clientIp);
  if (!quota.ok) {
    return jsonResponse({ error: 'RATE_LIMITED', message: quota.message }, quota.status, corsOrigin);
  }

  const jobId = crypto.randomUUID();
  const jobSecret = crypto.randomUUID();
  const r2Key = `uploads/${jobId}.zip`;
  const now = Date.now();

  const uploadMode = declaredSize <= UPLOAD_PART_BYTES ? 'single' : 'multipart';
  const expectedParts = uploadMode === 'single' ? 1 : Math.ceil(declaredSize / UPLOAD_PART_BYTES);

  let uploadId: string | undefined;
  const kvWrites: Array<Promise<void>> = [];

  if (uploadMode === 'multipart') {
    const mpu = await env.BUCKET.createMultipartUpload(r2Key, {
      httpMetadata: { contentType: PUT_CONTENT_TYPE },
    });
    uploadId = mpu.uploadId;
    const tracker: MultipartTrackerRecord = { r2Key, uploadId, createdAt: now };
    kvWrites.push(
      env.JOBS_KV.put(`${MPU_PREFIX}${jobId}`, JSON.stringify(tracker), {
        expirationTtl: MPU_TTL_SEC,
      })
    );
  }

  const reservation: ReservationRecord = { bytes: declaredSize, createdAt: now };
  const job: JobRecord = {
    id: jobId,
    jobSecret,
    r2Key,
    declaredSize,
    uploadMode,
    uploadId,
    partSize: UPLOAD_PART_BYTES,
    expectedParts,
    r2Deleted: false,
    status: 'awaiting_upload',
    metadata: metaCheck.value,
    createdAt: now,
    updatedAt: now,
  };

  kvWrites.push(
    env.JOBS_KV.put(`${RESERVATION_PREFIX}${jobId}`, JSON.stringify(reservation), {
      expirationTtl: RESERVATION_TTL_SEC,
    }),
    putJob(env, job)
  );
  await Promise.all(kvWrites);

  return jsonResponse(
    {
      jobId,
      jobSecret,
      uploadMode,
      partSize: UPLOAD_PART_BYTES,
      totalParts: expectedParts,
      contentType: PUT_CONTENT_TYPE,
      expiresIn: 300,
    },
    201,
    corsOrigin
  );
}

async function authorizeAwaitingUpload(
  env: Env,
  jobId: string,
  secret: string,
  corsOrigin: string | null
): Promise<{ ok: true; job: JobRecord } | { ok: false; response: Response }> {
  const job = await getJob(env, jobId);
  if (!job || !secret || !safeEqual(secret, job.jobSecret)) {
    return {
      ok: false,
      response: jsonResponse({ error: 'NOT_FOUND', message: '任务不存在或凭证无效' }, 404, corsOrigin),
    };
  }
  if (job.status !== 'awaiting_upload') {
    return {
      ok: false,
      response: jsonResponse({ error: 'INVALID_STATE', message: '当前任务状态不允许上传' }, 409, corsOrigin),
    };
  }
  return { ok: true, job };
}

async function handleDirectUpload(
  request: Request,
  url: URL,
  env: Env,
  jobId: string,
  corsOrigin: string | null
): Promise<Response> {
  const secret = url.searchParams.get('secret') || '';
  const auth = await authorizeAwaitingUpload(env, jobId, secret, corsOrigin);
  if (!auth.ok) return auth.response;

  const { job } = auth;
  if (job.uploadMode && job.uploadMode !== 'single') {
    return jsonResponse({ error: 'UPLOAD_MODE_MISMATCH', message: '该任务需分片上传' }, 400, corsOrigin);
  }

  const maxPkgBytes = parsePositiveInt(env.MAX_PACKAGE_BYTES, 1024 * 1024 * 1024);
  const maxSingleBytes = Math.min(maxPkgBytes, UPLOAD_PART_BYTES, job.declaredSize + 1024 * 1024);

  try {
    const obj = await writeR2FromRequest(request, maxSingleBytes, (payload) =>
      env.BUCKET.put(job.r2Key, payload, {
        httpMetadata: { contentType: PUT_CONTENT_TYPE },
      })
    );
    return jsonResponse({ uploaded: true, size: obj.size }, 200, corsOrigin);
  } catch (err) {
    if (err instanceof BodyLimitError) {
      return jsonResponse({ error: 'UPLOAD_REJECTED', message: err.message }, err.status, corsOrigin);
    }
    return jsonResponse({ error: 'UPLOAD_FAILED', message: '写入临时存储失败，请重试' }, 502, corsOrigin);
  }
}

async function handleUploadPart(
  request: Request,
  url: URL,
  env: Env,
  jobId: string,
  partNumberRaw: string,
  corsOrigin: string | null
): Promise<Response> {
  const secret = url.searchParams.get('secret') || '';
  const auth = await authorizeAwaitingUpload(env, jobId, secret, corsOrigin);
  if (!auth.ok) return auth.response;

  const { job } = auth;
  if (job.uploadMode !== 'multipart' || !job.uploadId) {
    return jsonResponse({ error: 'UPLOAD_MODE_MISMATCH', message: '任务未启用分片上传' }, 400, corsOrigin);
  }

  const expectedParts = job.expectedParts || 1;
  const partNumber = Number(partNumberRaw);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > expectedParts) {
    return jsonResponse({ error: 'INVALID_PART', message: '无效的分片编号' }, 400, corsOrigin);
  }

  const maxPartBytes = job.partSize || UPLOAD_PART_BYTES;
  const mpu = env.BUCKET.resumeMultipartUpload(job.r2Key, job.uploadId);

  try {
    const uploaded = await writeR2FromRequest(request, maxPartBytes, (payload) =>
      mpu.uploadPart(partNumber, payload)
    );
    return jsonResponse(
      { partNumber: uploaded.partNumber, etag: uploaded.etag },
      200,
      corsOrigin
    );
  } catch (err) {
    if (err instanceof BodyLimitError) {
      return jsonResponse({ error: 'UPLOAD_REJECTED', message: err.message }, err.status, corsOrigin);
    }
    return jsonResponse({ error: 'PART_UPLOAD_FAILED', message: '分片写入失败，正在重试' }, 502, corsOrigin);
  }
}

async function handleStartJob(
  request: Request,
  env: Env,
  jobId: string,
  corsOrigin: string | null
): Promise<Response> {
  let body: { secret?: string; parts?: unknown };
  try {
    body = (await request.json()) as { secret?: string; parts?: unknown };
  } catch {
    return jsonResponse({ error: 'BAD_JSON', message: '请求格式错误' }, 400, corsOrigin);
  }

  const job = await getJob(env, jobId);
  if (!job || !body.secret || !safeEqual(body.secret, job.jobSecret)) {
    return jsonResponse({ error: 'NOT_FOUND', message: '任务不存在或凭证无效' }, 404, corsOrigin);
  }

  if (job.status !== 'awaiting_upload') {
    return jsonResponse({ status: job.status, runId: job.runId }, 200, corsOrigin);
  }

  if (job.uploadMode === 'multipart' && job.uploadId) {
    const partsCheck = validateUploadedParts(body.parts, job.expectedParts || 1);
    if (!partsCheck.ok) {
      return jsonResponse({ error: 'PARTS_INCOMPLETE', message: partsCheck.error }, 400, corsOrigin);
    }
    const mpu = env.BUCKET.resumeMultipartUpload(job.r2Key, job.uploadId);
    try {
      await mpu.complete(partsCheck.parts);
    } catch {
      try { await mpu.abort(); } catch {}
      await Promise.all([
        env.JOBS_KV.delete(`${RESERVATION_PREFIX}${jobId}`),
        env.JOBS_KV.delete(`${MPU_PREFIX}${jobId}`),
      ]);
      job.r2Deleted = true;
      job.status = 'failed';
      job.errorMessage = '云端合并上传分片失败，请重新上传';
      await putJob(env, job);
      return jsonResponse({ error: 'MULTIPART_COMPLETE_FAILED', message: job.errorMessage }, 400, corsOrigin);
    }
    await env.JOBS_KV.delete(`${MPU_PREFIX}${jobId}`);
  }

  const maxPkgBytes = parsePositiveInt(env.MAX_PACKAGE_BYTES, 1024 * 1024 * 1024);
  const head = await env.BUCKET.head(job.r2Key);
  await env.JOBS_KV.delete(`${RESERVATION_PREFIX}${jobId}`);

  if (!head || head.size <= 0) {
    return jsonResponse(
      { error: 'UPLOAD_MISSING', message: '未检测到上传文件，请重新上传' },
      400,
      corsOrigin
    );
  }

  // Reject oversized uploads even if someone bypassed browser checks with the presigned URL.
  if (head.size > maxPkgBytes || head.size > job.declaredSize + 1024 * 1024) {
    await env.BUCKET.delete(job.r2Key);
    job.r2Deleted = true;
    job.status = 'rejected';
    job.errorMessage = '实际上传文件超出允许体积上限，已被自动清理';
    await putJob(env, job);
    return jsonResponse({ error: 'SIZE_MISMATCH', message: job.errorMessage }, 400, corsOrigin);
  }

  job.actualSize = head.size;

  try {
    const { runId } = await dispatchGithubBuild(env, jobId);
    job.status = 'queued';
    job.runId = runId;
    await putJob(env, job);
    return jsonResponse({ status: 'queued', runId }, 200, corsOrigin);
  } catch (err) {
    await env.BUCKET.delete(job.r2Key);
    job.r2Deleted = true;
    job.status = 'failed';
    job.errorMessage = err instanceof Error ? err.message : '触发云端编译失败';
    await putJob(env, job);
    return jsonResponse({ error: 'DISPATCH_FAILED', message: '触发云端编译失败' }, 502, corsOrigin);
  }
}

async function handleGetJobStatus(
  url: URL,
  env: Env,
  jobId: string,
  corsOrigin: string | null
): Promise<Response> {
  const secret = url.searchParams.get('secret') || '';
  const job = await getJob(env, jobId);
  if (!job || !secret || !safeEqual(secret, job.jobSecret)) {
    return jsonResponse({ error: 'NOT_FOUND', message: '任务不存在或凭证无效' }, 404, corsOrigin);
  }

  const latest = await syncFallbackFromGithubRun(env, job);
  return jsonResponse(
    {
      jobId: latest.id,
      status: latest.status,
      r2Deleted: latest.r2Deleted,
      artifactName: latest.artifactName,
      errorMessage: latest.errorMessage,
      updatedAt: latest.updatedAt,
    },
    200,
    corsOrigin
  );
}

function resolveDownloadZipFileName(artifactName: string | undefined, appName: string): string {
  const safeInput =
    artifactName && !/^installer-[0-9a-f-]{36}$/i.test(artifactName)
      ? artifactName
      : deriveExpectedArtifactName(appName);
  const baseName =
    safeInput
      .replace(/\.exe$/i, '')
      .replace(/\.zip$/i, '')
      .replace(/["\\\r\n]/g, '_') || 'TuKuai-Setup-x64';
  return `${baseName}.zip`;
}

function buildDownloadHeaders(
  downloadFileName: string,
  contentType: string,
  corsOrigin: string | null
): Headers {
  const asciiName = downloadFileName.replace(/[^\x20-\x7E]/g, '_') || 'TuKuai-Setup-x64.zip';
  const headers = new Headers();
  headers.set('content-type', contentType);
  headers.set('cache-control', 'no-store');
  headers.set('accept-ranges', 'bytes');
  headers.set('x-artifact-source', 'github');
  headers.set(
    'content-disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(downloadFileName)}`
  );
  if (corsOrigin) {
    headers.set('access-control-allow-origin', corsOrigin);
    headers.set('access-control-expose-headers', EXPOSED_DOWNLOAD_HEADERS);
    headers.set('vary', 'Origin');
  }
  return headers;
}

async function serveGithubArtifactDownload(
  request: Request,
  url: URL,
  env: Env,
  artifactId: string,
  downloadFileName: string,
  corsOrigin: string | null
): Promise<Response> {
  const ghArtifactZipUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/actions/artifacts/${artifactId}/zip`;
  const ghRes = await fetch(ghArtifactZipUrl, {
    headers: githubHeaders(env.GITHUB_PAT),
    redirect: 'manual',
  });

  const location = ghRes.headers.get('location');
  if (ghRes.status < 300 || ghRes.status >= 400 || !location) {
    return jsonResponse(
      { error: 'ARTIFACT_UNAVAILABLE', message: '安装包直链已过期或不存在' },
      410,
      corsOrigin
    );
  }

  if (url.searchParams.get('meta') === '1') {
    const probeRes = await fetch(location, { headers: { range: 'bytes=0-0' } });
    await probeRes.body?.cancel();
    if (!probeRes.ok && probeRes.status !== 206) {
      return jsonResponse(
        { error: 'ARTIFACT_FETCH_FAILED', message: '探测安装包大小失败，请稍后重试' },
        502,
        corsOrigin
      );
    }
    const cr = probeRes.headers.get('content-range') || '';
    const match = /\/(\d+)$/.exec(cr);
    const totalSize = match ? Number(match[1]) : Number(probeRes.headers.get('content-length') || '0');
    return jsonResponse(
      {
        ok: true,
        fileName: downloadFileName,
        size: Number.isFinite(totalSize) && totalSize > 0 ? totalSize : 0,
        source: 'github',
      },
      200,
      corsOrigin
    );
  }

  const upstreamHeaders: Record<string, string> = {};
  const startParam = url.searchParams.get('start');
  const endParam = url.searchParams.get('end');
  if (startParam !== null || endParam !== null) {
    const validStart = startParam === null || /^\d+$/.test(startParam);
    const validEnd = endParam === null || /^\d+$/.test(endParam);
    if (!validStart || !validEnd) {
      return jsonResponse({ error: 'INVALID_RANGE', message: '分片参数无效' }, 400, corsOrigin);
    }
    const startVal = startParam ?? '0';
    const endVal = endParam ?? '';
    if (endVal !== '' && Number(endVal) < Number(startVal)) {
      return new Response(null, { status: 416 });
    }
    upstreamHeaders['range'] = `bytes=${startVal}-${endVal}`;
  } else {
    const range = request.headers.get('range');
    const ifRange = request.headers.get('if-range');
    if (range) upstreamHeaders['range'] = range;
    if (ifRange) upstreamHeaders['if-range'] = ifRange;
  }

  const upstreamRes = await fetch(location, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers: upstreamHeaders,
  });
  if (!upstreamRes.ok && upstreamRes.status !== 206) {
    return jsonResponse(
      { error: 'ARTIFACT_FETCH_FAILED', message: '拉取安装包成品失败，请稍后重试' },
      502,
      corsOrigin
    );
  }

  const resHeaders = buildDownloadHeaders(
    downloadFileName,
    upstreamRes.headers.get('content-type') || ARTIFACT_ZIP_CONTENT_TYPE,
    corsOrigin
  );
  for (const h of ['content-length', 'content-range', 'etag']) {
    const val = upstreamRes.headers.get(h);
    if (val) resHeaders.set(h, val);
  }

  return new Response(request.method === 'HEAD' ? null : upstreamRes.body, {
    status: upstreamRes.status,
    headers: resHeaders,
  });
}

async function handleDownloadArtifact(
  request: Request,
  url: URL,
  env: Env,
  jobId: string,
  corsOrigin: string | null
): Promise<Response> {
  const secret = url.searchParams.get('secret') || '';
  let job = await getJob(env, jobId);
  if (!job || !secret || !safeEqual(secret, job.jobSecret)) {
    return jsonResponse({ error: 'NOT_FOUND', message: '任务不存在或凭证无效' }, 404, corsOrigin);
  }

  job = await syncFallbackFromGithubRun(env, job);
  if (job.status !== 'succeeded' || !job.artifactId) {
    return jsonResponse({ error: 'NOT_READY', message: '安装包尚未生成完成' }, 409, corsOrigin);
  }

  const downloadFileName = resolveDownloadZipFileName(job.artifactName, job.metadata?.appName || '');
  return serveGithubArtifactDownload(
    request,
    url,
    env,
    job.artifactId,
    downloadFileName,
    corsOrigin
  );
}

async function handleInternalClaim(request: Request, env: Env, jobId: string): Promise<Response> {
  if (!isRunnerAuthorized(request, env)) {
    return jsonResponse({ error: 'UNAUTHORIZED' }, 401);
  }
  const job = await getJob(env, jobId);
  if (!job || job.status !== 'queued') {
    return jsonResponse({ error: 'INVALID_STATE' }, 409);
  }

  const downloadUrl = await presignR2Url({
    method: 'GET',
    accountId: env.R2_ACCOUNT_ID,
    bucket: env.R2_BUCKET_NAME,
    key: job.r2Key,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    expiresSeconds: 600,
  });

  job.status = 'building';
  await putJob(env, job);

  return jsonResponse({
    downloadUrl,
    metadata: job.metadata,
  });
}

async function handleInternalDownloaded(request: Request, env: Env, jobId: string): Promise<Response> {
  if (!isRunnerAuthorized(request, env)) {
    return jsonResponse({ error: 'UNAUTHORIZED' }, 401);
  }
  const job = await getJob(env, jobId);
  if (!job) {
    return jsonResponse({ error: 'NOT_FOUND' }, 404);
  }

  if (!job.r2Deleted) {
    await env.BUCKET.delete(job.r2Key);
    job.r2Deleted = true;
  }
  if (job.status === 'building' || job.status === 'queued') {
    job.status = 'compiling';
  }
  await putJob(env, job);
  return jsonResponse({ deleted: true });
}

async function handleInternalComplete(request: Request, env: Env, jobId: string): Promise<Response> {
  if (!isRunnerAuthorized(request, env)) {
    return jsonResponse({ error: 'UNAUTHORIZED' }, 401);
  }
  const job = await getJob(env, jobId);
  if (!job) {
    return jsonResponse({ error: 'NOT_FOUND' }, 404);
  }

  const payload = (await request.json()) as {
    ok?: boolean;
    runId?: string;
    artifactId?: string;
    artifactName?: string;
    errorMessage?: string;
  };

  if (!job.r2Deleted) {
    await env.BUCKET.delete(job.r2Key);
    job.r2Deleted = true;
  }

  if (payload.runId) job.runId = String(payload.runId);
  const hasGithubArtifact = Boolean(payload.artifactId);

  if (payload.ok && hasGithubArtifact) {
    job.status = 'succeeded';
    job.artifactId = String(payload.artifactId);
    job.artifactName =
      payload.artifactName && !/^installer-[0-9a-f-]{36}$/i.test(payload.artifactName)
        ? payload.artifactName
        : deriveExpectedArtifactName(job.metadata?.appName || '');
  } else {
    job.status = 'failed';
    job.errorMessage = payload.errorMessage || '云端编译失败，请检查包结构后重试';
  }

  await putJob(env, job);
  return jsonResponse({ updated: true });
}

async function cleanupOrphanR2Objects(env: Env): Promise<number> {
  const now = Date.now();
  const mpuCutoff = now - ORPHAN_MAX_AGE_MS;
  let deletedCount = 0;
  let cursor: string | undefined;

  do {
    const listed = await env.BUCKET.list({ cursor, limit: 1000 });
    const expiredKeys = listed.objects
      .filter((obj) => shouldExpireR2Object(obj.uploaded.getTime(), now, ORPHAN_MAX_AGE_MS))
      .map((obj) => obj.key);

    if (expiredKeys.length > 0) {
      await env.BUCKET.delete(expiredKeys);
      deletedCount += expiredKeys.length;
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  // Also abort stale uncommitted multipart uploads so abandoned parts do not linger in R2.
  let mpuCursor: string | undefined;
  do {
    const kvList = await env.JOBS_KV.list({ prefix: MPU_PREFIX, cursor: mpuCursor });
    const records = await Promise.all(
      kvList.keys.map(async (item) => ({
        key: item.name,
        rec: await env.JOBS_KV.get<MultipartTrackerRecord>(item.name, 'json'),
      }))
    );
    for (const { key, rec } of records) {
      if (!rec || rec.createdAt < mpuCutoff) {
        if (rec?.r2Key && rec?.uploadId) {
          try {
            await env.BUCKET.resumeMultipartUpload(rec.r2Key, rec.uploadId).abort();
            deletedCount++;
          } catch {
            // Ignore already completed or aborted multipart uploads.
          }
        }
        await env.JOBS_KV.delete(key);
      }
    }
    mpuCursor = kvList.list_complete ? undefined : kvList.cursor;
  } while (mpuCursor);

  return deletedCount;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    const corsOrigin = resolveAllowedOrigin(origin, env.ALLOWED_ORIGINS || '');

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return handleCorsPreflight(corsOrigin);
    }

    if (url.pathname === '/api/health' && request.method === 'GET') {
      return jsonResponse({ ok: true }, 200, corsOrigin);
    }

    if (url.pathname === '/api/jobs' && request.method === 'POST') {
      return handleCreateJob(request, env, corsOrigin);
    }

    const partMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/parts\/([0-9]+)$/);
    if (partMatch && isValidUuid(partMatch[1]) && (request.method === 'PUT' || request.method === 'POST')) {
      return handleUploadPart(request, url, env, partMatch[1], partMatch[2], corsOrigin);
    }

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(upload|start|download))?$/);
    if (jobMatch && isValidUuid(jobMatch[1])) {
      const [, jobId, action] = jobMatch;
      if (!action && request.method === 'GET') {
        return handleGetJobStatus(url, env, jobId, corsOrigin);
      }
      if (action === 'upload' && (request.method === 'PUT' || request.method === 'POST')) {
        return handleDirectUpload(request, url, env, jobId, corsOrigin);
      }
      if (action === 'start' && request.method === 'POST') {
        return handleStartJob(request, env, jobId, corsOrigin);
      }
      if (action === 'download' && (request.method === 'GET' || request.method === 'HEAD')) {
        return handleDownloadArtifact(request, url, env, jobId, corsOrigin);
      }
    }

    const internalMatch = url.pathname.match(
      /^\/api\/internal\/jobs\/([^/]+)\/(claim|downloaded|complete)$/
    );
    if (internalMatch && isValidUuid(internalMatch[1]) && request.method === 'POST') {
      const [, jobId, action] = internalMatch;
      if (action === 'claim') return handleInternalClaim(request, env, jobId);
      if (action === 'downloaded') return handleInternalDownloaded(request, env, jobId);
      if (action === 'complete') return handleInternalComplete(request, env, jobId);
    }

    if (url.pathname === '/' && env.ASSETS) {
      return Response.redirect(new URL('/TuKuaiEXE.html', url.origin).toString(), 302);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return jsonResponse({ error: 'NOT_FOUND' }, 404, corsOrigin);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(cleanupOrphanR2Objects(env));
  },
};
