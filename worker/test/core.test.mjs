import assert from 'node:assert/strict';
import test from 'node:test';
import { presignR2Url } from '../src/sigv4.ts';
import {
  isValidUuid,
  resolveAllowedOrigin,
  safeEqual,
  validateBuildMetadata,
  validateUploadedParts,
} from '../src/validation.ts';

test('validateBuildMetadata accepts valid Chinese and ASCII metadata', () => {
  const result = validateBuildMetadata({
    appName: '土块测试工具',
    appVersion: '1.2.0',
    appPublisher: 'TuKuai Studio',
    mainExe: 'dist/MyApp.exe',
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.mainExe, 'dist\\MyApp.exe');
  }
});

test('validateBuildMetadata blocks INI injection and path traversal', () => {
  const badName = validateBuildMetadata({
    appName: 'App"\r\n[Run]\r\nFilename=calc.exe',
    appVersion: '1.0.0',
    appPublisher: 'TuKuai',
    mainExe: 'app.exe',
  });
  assert.equal(badName.ok, false);

  const badExe = validateBuildMetadata({
    appName: 'GoodApp',
    appVersion: '1.0.0',
    appPublisher: 'TuKuai',
    mainExe: '..\\..\\evil.exe',
  });
  assert.equal(badExe.ok, false);

  const badVersion = validateBuildMetadata({
    appName: 'GoodApp',
    appVersion: 'v1.0-beta',
    appPublisher: 'TuKuai',
    mainExe: 'app.exe',
  });
  assert.equal(badVersion.ok, false);
});

test('resolveAllowedOrigin checks exact origin membership', () => {
  const csv = 'https://xn--2esp7m.xn--udsye.art, http://localhost:8787';
  assert.equal(
    resolveAllowedOrigin('https://xn--2esp7m.xn--udsye.art', csv),
    'https://xn--2esp7m.xn--udsye.art'
  );
  assert.equal(resolveAllowedOrigin('https://evil.example.com', csv), null);
  assert.equal(resolveAllowedOrigin(null, csv), null);
});

test('safeEqual and isValidUuid behave accurately', () => {
  assert.equal(safeEqual('secret-123', 'secret-123'), true);
  assert.equal(safeEqual('secret-123', 'secret-124'), false);
  assert.equal(safeEqual('short', 'longer'), false);
  assert.equal(isValidUuid('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(isValidUuid('not-a-uuid'), false);
});

test('presignR2Url produces valid AWS SigV4 presigned query URL', async () => {
  const url = new URL(
    await presignR2Url({
      method: 'PUT',
      accountId: '82cb7d7b7d8f5f9b2247a4326dd0f162',
      bucket: 'tukuai-exe-temp',
      key: 'uploads/550e8400-e29b-41d4-a716-446655440000.zip',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'SECRETEXAMPLE',
      expiresSeconds: 300,
      contentType: 'application/octet-stream',
      now: new Date('2026-11-14T12:00:00.000Z'),
    })
  );

  assert.equal(url.hostname, '82cb7d7b7d8f5f9b2247a4326dd0f162.r2.cloudflarestorage.com');
  assert.equal(url.pathname, '/tukuai-exe-temp/uploads/550e8400-e29b-41d4-a716-446655440000.zip');
  assert.equal(url.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.equal(url.searchParams.get('X-Amz-Credential'), 'AKIAEXAMPLE/20261114/auto/s3/aws4_request');
  assert.equal(url.searchParams.get('X-Amz-Date'), '20261114T120000Z');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '300');
  assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host');
  assert.match(url.searchParams.get('X-Amz-Signature') || '', /^[0-9a-f]{64}$/);
});

test('validateUploadedParts validates completeness and sorts parts ascending', () => {
  const valid = validateUploadedParts(
    [
      { partNumber: 2, etag: '"etag-2"' },
      { partNumber: 1, etag: '"etag-1"' },
    ],
    2
  );
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.deepEqual(valid.parts, [
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
    ]);
  }

  assert.equal(validateUploadedParts([{ partNumber: 1, etag: '"e1"' }], 2).ok, false);
  assert.equal(
    validateUploadedParts(
      [
        { partNumber: 1, etag: '"e1"' },
        { partNumber: 1, etag: '"e1"' },
      ],
      2
    ).ok,
    false
  );
  assert.equal(validateUploadedParts([{ partNumber: 3, etag: '"e3"' }], 1).ok, false);
});
