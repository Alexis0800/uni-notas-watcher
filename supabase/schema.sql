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
  -- Lista de códigos de período que trae el selector de INTRALU (ej.
  -- ["20261","20252",...]) — se llena gratis durante el chequeo normal del
  -- ciclo actual, la usa /ciclos para armar los botones.
  periodos_disponibles jsonb not null default '[]'::jsonb,
  -- Caché permanente de ciclos pasados ya consultados por /ciclos, clave
  -- codper: mismo formato que `cursos`. Nunca lo toca el chequeo de 5 min
  -- (eso solo escribe `cursos`) — solo fetch-historial.js, bajo demanda.
  historial jsonb not null default '{}'::jsonb,
  -- Claves de las publicaciones de la home de INTRALU (anuncios,
  -- reglamentos, resoluciones, manuales) que este usuario ya recibió por
  -- Telegram, para no avisarle dos veces lo mismo. Formato de cada clave:
  -- "tipo|fecha|titulo" (ver clavePublicacion en check-anuncios.js). Se
  -- recorta a las últimas 100 para que no crezca sin fin.
  anuncios_vistos jsonb not null default '[]'::jsonb,
  -- false hasta la primera corrida de check-anuncios.js: esa primera vez
  -- solo guarda lo que ya está publicado, sin avisar nada — si no, alguien
  -- que se registra hoy recibiría de golpe todos los anuncios viejos.
  anuncios_seeded boolean not null default false,
  -- Switch de /avisos. Activado por defecto. Apagarlo NO da de baja al
  -- usuario: las notificaciones de notas nuevas siguen llegando (para
  -- darse de baja del todo está /baja).
  avisos_activos boolean not null default true,
  -- false hasta el primer chequeo tras registrarse: ese primer chequeo solo
  -- guarda el estado base sin notificar, para no avisar "nota nueva" de
  -- notas que la persona ya tenía antes de registrarse.
  seeded boolean not null default false,
  active boolean not null default true,
  consecutive_failures integer not null default 0,
  -- true si ya se le avisó una vez que INTRALU no respondía durante su
  -- primer chequeo (registro nuevo) — evita repetir ese aviso en cada
  -- reintento de 5 min mientras la caída dure. Se resetea a false en
  -- cuanto un chequeo tiene éxito.
  network_issue_notified boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- RLS activado y SIN policies: nadie puede leer/escribir esta tabla con el
-- anon key. Solo el service_role key (que usan la Edge Function y el chequeo
-- de GitHub Actions, y que nunca se expone al público) puede tocarla, porque
-- ese key ignora RLS por diseño de Supabase.
alter table usuarios enable row level security;

-- Una fila por servicio externo trackeado (hoy solo INTRALU). is_down +
-- since permiten avisar al admin una sola vez por caída/recuperación en vez
-- de una vez por usuario o por corrida del cron — ver lib/service-status.js.
-- down_notified: false mientras la caída no cruzó el umbral mínimo de aviso
-- (10 min) — evita spamear con blips cortos que se recuperan solos.
create table if not exists service_status (
  service text primary key,
  is_down boolean not null default false,
  since timestamptz,
  down_notified boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into service_status (service) values ('intralu') on conflict do nothing;

alter table service_status enable row level security;

-- Quiénes preguntaron (/notas o /estado) mientras el servicio estaba caído
-- (down_notified=true, ver lib/service-status.js) — así solo se les avisa a
-- ellos cuando se recupera, en vez de a todos los usuarios activos. Se
-- vacía por completo en cada recuperación (markIntraluUp en
-- lib/service-status.js).
create table if not exists service_status_interesados (
  service text not null references service_status(service),
  chat_id bigint not null,
  created_at timestamptz not null default now(),
  primary key (service, chat_id)
);
alter table service_status_interesados enable row level security;

-- Migración para una base ya desplegada (el create table de arriba solo
-- aplica a instalaciones nuevas) — pega y corre esto una vez en el SQL
-- Editor de tu proyecto de Supabase si tu tabla `usuarios` ya existía antes
-- de este cambio:
--
-- alter table usuarios add column if not exists periodos_disponibles jsonb not null default '[]'::jsonb;
-- alter table usuarios add column if not exists historial jsonb not null default '{}'::jsonb;
-- alter table usuarios add column if not exists network_issue_notified boolean not null default false;
-- alter table usuarios add column if not exists anuncios_vistos jsonb not null default '[]'::jsonb;
-- alter table usuarios add column if not exists anuncios_seeded boolean not null default false;
-- alter table usuarios add column if not exists avisos_activos boolean not null default true;
--
-- create table if not exists service_status (
--   service text primary key,
--   is_down boolean not null default false,
--   since timestamptz,
--   down_notified boolean not null default false,
--   updated_at timestamptz not null default now()
-- );
-- insert into service_status (service) values ('intralu') on conflict do nothing;
-- alter table service_status enable row level security;
-- alter table service_status add column if not exists down_notified boolean not null default false;
--
-- create table if not exists service_status_interesados (
--   service text not null references service_status(service),
--   chat_id bigint not null,
--   created_at timestamptz not null default now(),
--   primary key (service, chat_id)
-- );
-- alter table service_status_interesados enable row level security;
