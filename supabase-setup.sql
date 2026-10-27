-- Run this in Supabase Dashboard > SQL Editor for your Status HD project.
create table if not exists public.status_hd_activation_requests (
  id uuid primary key default gen_random_uuid(),
  phone text not null,
  nonce text not null,
  status text not null default 'pending' check (status in ('pending','activated','expired')),
  expires_at timestamptz not null,
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (phone, nonce)
);

alter table public.status_hd_activation_requests enable row level security;
-- No anon/authenticated policies are created intentionally. Only the backend's
-- service-role key should access this table; never expose that key in HTML.
create index if not exists status_hd_activation_phone_nonce_idx
  on public.status_hd_activation_requests (phone, nonce, status);
create index if not exists status_hd_activation_expiry_idx
  on public.status_hd_activation_requests (expires_at);
