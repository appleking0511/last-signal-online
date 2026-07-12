-- Supabase Dashboard > SQL Editor에서 한 번만 실행하세요.
create table if not exists public.game_rooms (
  code text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.game_rooms enable row level security;

-- 게임 데이터는 Render의 서버 비밀 키로만 접근합니다.
revoke all on table public.game_rooms from anon, authenticated;
grant select, insert, update, delete on table public.game_rooms to service_role;

create index if not exists game_rooms_updated_at_idx
  on public.game_rooms (updated_at);
