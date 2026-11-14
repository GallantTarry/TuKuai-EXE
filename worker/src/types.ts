export type JobStatus =
  | 'awaiting_upload'
  | 'queued'
  | 'building'
  | 'compiling'
  | 'succeeded'
  | 'failed'
  | 'rejected';

export interface BuildMetadata {
  appName: string;
  appVersion: string;
  appPublisher: string;
  mainExe: string;
}

export interface JobRecord {
  id: string;
  jobSecret: string;
  r2Key: string;
  declaredSize: number;
  actualSize?: number;
  uploadMode?: 'single' | 'multipart';
  uploadId?: string;
  partSize?: number;
  expectedParts?: number;
  r2Deleted: boolean;
  status: JobStatus;
  metadata: BuildMetadata;
  createdAt: number;
  updatedAt: number;
  runId?: string;
  artifactR2Key?: string;
  artifactSize?: number;
  artifactId?: string;
  artifactName?: string;
  errorMessage?: string;
}

export interface MultipartTrackerRecord {
  r2Key: string;
  uploadId: string;
  createdAt: number;
}

export interface ReservationRecord {
  bytes: number;
  createdAt: number;
}

export interface Env {
  BUCKET: R2Bucket;
  JOBS_KV: KVNamespace;
  ASSETS?: Fetcher;

  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_WORKFLOW_FILE: string;
  GITHUB_REF: string;
  ALLOWED_ORIGINS: string;
  MAX_PACKAGE_BYTES: string;
  MAX_BUCKET_BYTES: string;
  DAILY_JOB_CAP: string;
  IP_HOURLY_CAP: string;

  // Secrets provisioned via `wrangler secret put`
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  GITHUB_PAT: string;
  TURNSTILE_SECRET_KEY: string;
  RUNNER_AUTH_SECRET: string;
}
