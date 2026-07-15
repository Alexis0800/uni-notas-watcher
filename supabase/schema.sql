-- Pega y corre esto una vez en el SQL Editor de tu proyecto de Supabase
-- (Dashboard → SQL Editor → New query).

create extension if not exists pgcrypto;

create table if not exists usuarios (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null unique,
  codigo_uni text not null,
  password_encrypted text not null,
  last_grades jsonb not null default '{}'::jsonb,
  -- Fórmulas y promedios por curso del ciclo actual (para /simular), clave
  -- "codcur-seccion": { nombre, formulas: {practicas, teoria}, promedios }.
  cursos jsonb not null default '{}'::jsonb,
  -- false hasta el primer chequeo tras registrarse: ese primer chequeo solo
  -- guarda el estado base sin notificar, para no avisar "nota nueva" de
  -- notas que la persona ya tenía antes de registrarse.
  seeded boolean not null default false,
  active boolean not null default true,
  consecutive_failures integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS activado y SIN policies: nadie puede leer/escribir esta tabla con el
-- anon key. Solo el service_role key (que usan la Edge Function y el chequeo
-- de GitHub Actions, y que nunca se expone al público) puede tocarla, porque
-- ese key ignora RLS por diseño de Supabase.
alter table usuarios enable row level security;
