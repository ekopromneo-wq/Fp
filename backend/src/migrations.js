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
  {
    id: '006_recording_speakers',
    sql: `
      create table if not exists recording_speakers (
        id uuid primary key default gen_random_uuid(),
        recording_id uuid not null references recordings(id) on delete cascade,
        label text not null,
        display_name text not null,
        contact_name text,
        contact_email text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (recording_id, label)
      );

      create index if not exists recording_speakers_recording_id_idx on recording_speakers(recording_id);
    `,
  },
  {
    id: '007_projects_recording_metadata',
    sql: `
      create table if not exists projects (
        id uuid primary key default gen_random_uuid(),
        owner_id uuid references app_users(id) on delete set null,
        name text not null,
        color text not null default '#235b4f',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      alter table recordings
        add column if not exists project_id uuid references projects(id) on delete set null,
        add column if not exists auto_named boolean not null default false;

      create index if not exists projects_owner_id_idx on projects(owner_id);
      create index if not exists projects_created_at_idx on projects(created_at desc);
      create index if not exists recordings_project_id_idx on recordings(project_id);
    `,
  },
  {
    id: '008_user_smtp_config',
    sql: `
      alter table app_users
        add column if not exists smtp_config jsonb;
    `,
  },
  {
    id: '009_telegram_bitrix_channels',
    sql: `
      alter table app_users
        add column if not exists telegram_config jsonb,
        add column if not exists bitrix_config jsonb;

      alter table recording_tasks
        add column if not exists external_refs jsonb not null default '{}'::jsonb;
    `,
  },
  {
    id: '010_user_diarization_config',
    sql: `
      alter table app_users
        add column if not exists diarization_config jsonb;
    `,
  },
  {
    id: '011_meeting_bot_recordings',
    sql: `
      alter table recordings
        add column if not exists meeting_bot_task_id text,
        add column if not exists meeting_url text;
    `,
  },
  {
    id: '012_recorder_bot',
    sql: `
      alter table recordings
        add column if not exists recorder_engine text;
    `,
  },
  {
    id: '013_upload_sessions',
    sql: `
      create table if not exists upload_sessions (
        id uuid primary key default gen_random_uuid(),
        recording_id uuid not null references recordings(id) on delete cascade,
        owner_id uuid references app_users(id) on delete set null,
        original_filename text not null,
        mime_type text not null,
        total_size_bytes bigint not null,
        chunk_size_bytes integer not null,
        bytes_received bigint not null default 0,
        staging_path text not null,
        status text not null default 'uploading'
          check (status in ('uploading', 'completed', 'failed')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (recording_id)
      );
    `,
  },
  {
    id: '014_pipeline_stages',
    sql: `
      alter table recordings drop constraint recordings_status_check;
      alter table recordings add constraint recordings_status_check
        check (status in ('uploaded', 'queued', 'processing', 'transcribing', 'summarizing', 'done', 'failed'));

      alter table recordings add column if not exists failure_count integer not null default 0;
      alter table processing_jobs add column if not exists cancel_requested boolean not null default false;
    `,
  },
  {
    id: '015_notifications',
    sql: `
      alter table app_users add column if not exists notification_config jsonb not null default '{}'::jsonb;

      create table if not exists notifications (
        id uuid primary key default gen_random_uuid(),
        owner_id uuid not null references app_users(id) on delete cascade,
        recording_id uuid references recordings(id) on delete cascade,
        type text not null check (type in ('done', 'failed')),
        title text not null,
        message text not null,
        read_at timestamptz,
        created_at timestamptz not null default now()
      );
      create index if not exists notifications_owner_id_idx on notifications(owner_id, created_at desc);
    `,
  },
  {
    id: '016_transcript_editing',
    sql: `
      alter table transcripts add column if not exists original_text text;
      alter table transcripts add column if not exists original_segments jsonb;
      alter table transcripts add column if not exists is_locked boolean not null default false;

      update transcripts set original_text = text, original_segments = segments where original_text is null;
    `,
  },
  {
    id: '017_speakers_and_contacts',
    sql: `
      alter table recording_speakers add column if not exists suggested_name text;
      alter table recording_speakers add column if not exists suggestion_confidence text
        check (suggestion_confidence in ('high', 'medium', 'low') or suggestion_confidence is null);
      alter table recording_speakers add column if not exists suggestion_evidence text;
      alter table recording_speakers add column if not exists suggestion_status text not null default 'none'
        check (suggestion_status in ('none', 'pending', 'accepted', 'rejected'));

      create table if not exists contacts (
        id uuid primary key default gen_random_uuid(),
        owner_id uuid not null references app_users(id) on delete cascade,
        name text not null,
        organization text,
        position text,
        email text,
        phone text,
        source text not null default 'manual' check (source in ('manual', 'csv', 'vcard', 'bitrix')),
        external_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists contacts_owner_id_idx on contacts(owner_id);
    `,
  },
  {
    id: '018_meeting_protocol',
    sql: `
      alter table recordings add column if not exists meeting_type text not null default 'meeting'
        check (meeting_type in ('planning', 'negotiation', 'interview', 'project', 'meeting', 'freeform'));

      alter table recording_summaries add column if not exists executive_summary text;
      alter table recording_summaries add column if not exists original_summary jsonb;
      alter table recording_summaries add column if not exists is_locked boolean not null default false;

      update recording_summaries
      set original_summary = jsonb_build_object(
        'summary', summary,
        'executiveSummary', executive_summary,
        'protocol', protocol,
        'topics', topics
      )
      where original_summary is null;
    `,
  },
  {
    id: '019_task_resolution',
    sql: `
      alter table recording_tasks add column if not exists due_date timestamptz;
      alter table recording_tasks add column if not exists assignee_external boolean not null default false;
      alter table recording_tasks add column if not exists overdue_notified_at timestamptz;

      alter table notifications drop constraint notifications_type_check;
      alter table notifications add constraint notifications_type_check
        check (type in ('done', 'failed', 'task_overdue'));
    `,
  },
  {
    id: '020_projects_search',
    sql: `
      alter table projects add column if not exists description text;
      alter table projects add column if not exists archived_at timestamptz;

      create table if not exists recording_projects (
        recording_id uuid not null references recordings(id) on delete cascade,
        project_id uuid not null references projects(id) on delete cascade,
        created_at timestamptz not null default now(),
        primary key (recording_id, project_id)
      );

      create index if not exists recording_projects_project_id_idx on recording_projects(project_id);

      insert into recording_projects (recording_id, project_id)
      select id, project_id from recordings where project_id is not null
      on conflict do nothing;

      create table if not exists project_members (
        id uuid primary key default gen_random_uuid(),
        project_id uuid not null references projects(id) on delete cascade,
        contact_id uuid references contacts(id) on delete set null,
        display_name text not null,
        created_at timestamptz not null default now()
      );

      create index if not exists project_members_project_id_idx on project_members(project_id);
    `,
  },
  {
    id: '021_deliveries_and_share_links',
    sql: `
      -- US-11.1 «фиксируем доставку»: одна строка на попытку отправки в канал,
      -- включая проваленные — журнал нужен и для показа ошибки с предложением
      -- сменить канал, и для подсказки получателей по истории.
      create table if not exists deliveries (
        id uuid primary key default gen_random_uuid(),
        owner_id uuid not null references app_users(id) on delete cascade,
        recording_id uuid not null references recordings(id) on delete cascade,
        channel text not null check (channel in ('email', 'telegram', 'bitrix')),
        payload_kind text not null check (payload_kind in ('protocol', 'summary', 'tasks')),
        recipients jsonb not null default '[]'::jsonb,
        status text not null check (status in ('sent', 'failed')),
        attempts integer not null default 1,
        last_error text,
        external_refs jsonb not null default '{}'::jsonb,
        created_at timestamptz not null default now()
      );

      create index if not exists deliveries_recording_id_idx on deliveries(recording_id, created_at desc);
      create index if not exists deliveries_owner_id_idx on deliveries(owner_id, created_at desc);

      -- US-11.1 «ссылка на результат»: срок действия неделя, доступ отзывается,
      -- пароль не нужен — токена достаточно.
      create table if not exists share_links (
        id uuid primary key default gen_random_uuid(),
        token text not null unique,
        owner_id uuid not null references app_users(id) on delete cascade,
        recording_id uuid not null references recordings(id) on delete cascade,
        payload_kind text not null check (payload_kind in ('protocol', 'summary', 'tasks')),
        expires_at timestamptz not null,
        revoked_at timestamptz,
        created_at timestamptz not null default now()
      );

      create index if not exists share_links_recording_id_idx on share_links(recording_id, created_at desc);

      alter table app_users add column if not exists send_config jsonb;
    `,
  },
  {
    id: '022_telegram_tasks',
    sql: `
      -- US-11.3: получатели задач — контакты с привязанным Telegram. Боту нужен
      -- chat id (username недостаточно: Bot API не шлёт по имени), и контакт
      -- должен сам запустить бота — это ограничение Telegram, не наше.
      alter table contacts add column if not exists telegram_chat_id text;

      -- «Взять в работу» с inline-кнопки (US-11.3).
      alter table recording_tasks drop constraint recording_tasks_status_check;
      alter table recording_tasks add constraint recording_tasks_status_check
        check (status in ('extracted', 'confirmed', 'sent', 'in_progress', 'done', 'dismissed'));

      -- Курсор getUpdates на каждого бота (ключ — хеш токена, сам токен в
      -- таблице не живёт): без него перезапуск воркера обрабатывал бы старые
      -- нажатия кнопок заново.
      create table if not exists telegram_bot_cursors (
        bot_key text primary key,
        last_update_id bigint not null default 0,
        updated_at timestamptz not null default now()
      );
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
