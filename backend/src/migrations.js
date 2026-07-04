import { query } from './db.js';

const migrations = [
  {
    id: '001_initial_core',
    sql: `
      create extension if not exists pgcrypto;

      create table if not exists app_users (
        id uuid primary key default gen_random_uuid(),
        display_name text not null,
        email text unique,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists recordings (
        id uuid primary key default gen_random_uuid(),
        owner_id uuid references app_users(id) on delete set null,
        title text not null,
        status text not null default 'uploaded'
          check (status in ('uploaded', 'queued', 'processing', 'done', 'failed')),
        source text not null default 'manual',
        duration_seconds integer,
        storage_key text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists processing_jobs (
        id uuid primary key default gen_random_uuid(),
        recording_id uuid not null references recordings(id) on delete cascade,
        queue_job_id text,
        status text not null default 'queued'
          check (status in ('queued', 'processing', 'done', 'failed')),
        error text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists transcripts (
        id uuid primary key default gen_random_uuid(),
        recording_id uuid not null references recordings(id) on delete cascade,
        job_id uuid references processing_jobs(id) on delete set null,
        language text not null default 'ru',
        text text not null,
        segments jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create index if not exists recordings_created_at_idx on recordings(created_at desc);
      create index if not exists processing_jobs_recording_id_idx on processing_jobs(recording_id);
      create index if not exists transcripts_recording_id_idx on transcripts(recording_id);
    `,
  },
  {
    id: '002_recording_file_metadata',
    sql: `
      alter table recordings
        add column if not exists original_filename text,
        add column if not exists mime_type text,
        add column if not exists file_size_bytes bigint;
    `,
  },
  {
    id: '003_auth_credentials_sessions',
    sql: `
      alter table app_users
        add column if not exists password_hash text;

      create table if not exists auth_sessions (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references app_users(id) on delete cascade,
        token_hash text not null unique,
        expires_at timestamptz not null,
        created_at timestamptz not null default now(),
        last_seen_at timestamptz not null default now()
      );

      create index if not exists auth_sessions_user_id_idx on auth_sessions(user_id);
      create index if not exists auth_sessions_expires_at_idx on auth_sessions(expires_at);
    `,
  },
  {
    id: '004_recording_summaries',
    sql: `
      create table if not exists recording_summaries (
        id uuid primary key default gen_random_uuid(),
        recording_id uuid not null references recordings(id) on delete cascade,
        transcript_id uuid references transcripts(id) on delete set null,
        model text not null,
        summary text not null,
        action_items jsonb not null default '[]'::jsonb,
        topics jsonb not null default '[]'::jsonb,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create index if not exists recording_summaries_recording_id_idx on recording_summaries(recording_id);
    `,
  },
  {
    id: '005_recording_protocol_tasks',
    sql: `
      alter table recording_summaries
        add column if not exists protocol jsonb not null default '{"agenda":[],"decisions":[],"risks":[]}'::jsonb;

      create table if not exists recording_tasks (
        id uuid primary key default gen_random_uuid(),
        recording_id uuid not null references recordings(id) on delete cascade,
        summary_id uuid references recording_summaries(id) on delete set null,
        transcript_id uuid references transcripts(id) on delete set null,
        assignee text,
        description text not null,
        due_text text,
        status text not null default 'extracted'
          check (status in ('extracted', 'confirmed', 'sent', 'done', 'dismissed')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create index if not exists recording_tasks_recording_id_idx on recording_tasks(recording_id);
      create index if not exists recording_tasks_summary_id_idx on recording_tasks(summary_id);
      create index if not exists recording_tasks_status_idx on recording_tasks(status);
    `,
  },
];

export async function runMigrations() {
  await query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    );
  `);

  for (const migration of migrations) {
    const applied = await query('select id from schema_migrations where id = $1', [migration.id]);

    if (applied.rowCount > 0) {
      continue;
    }

    await query(migration.sql);
    await query('insert into schema_migrations (id) values ($1) on conflict (id) do nothing', [migration.id]);
    console.log(`Ensured migration ${migration.id}`);
  }
}
