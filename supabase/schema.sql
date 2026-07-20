-- Run this in the Supabase SQL editor to set up the source-of-truth tables.

create table if not exists menu_items (
  id uuid primary key,
  name text not null,
  price numeric not null,
  category text,
  updated_at timestamptz not null default now()
);

create table if not exists inventory (
  menu_item_id uuid primary key references menu_items(id) on delete cascade,
  stock integer not null default 0
);

create table if not exists orders (
  id uuid primary key, -- client-generated UUID, makes re-sync idempotent
  items jsonb not null, -- [{menu_item_id, name, price, qty}]
  total numeric not null,
  created_at timestamptz not null,
  terminal_id text -- which device/terminal created this order
);

-- Inventory deltas are applied through this function, NEVER via a raw
-- UPDATE from the client. This keeps the "subtract 2 from whatever's
-- there" semantics atomic even if 5 terminals hit it at the same moment.
create or replace function apply_inventory_delta(
  p_menu_item_id uuid,
  p_delta integer
) returns integer as $$
declare
  new_stock integer;
begin
  update inventory
  set stock = stock + p_delta
  where menu_item_id = p_menu_item_id
  returning stock into new_stock;

  if not found then
    insert into inventory (menu_item_id, stock) values (p_menu_item_id, p_delta)
    returning stock into new_stock;
  end if;

  return new_stock;
end;
$$ language plpgsql;

-- Orders: insert-once. ON CONFLICT DO NOTHING means a retried sync after
-- a dropped connection never double-inserts or double-counts revenue.
-- (Applied from the client as an upsert with ignoreDuplicates.)

-- Bar settings: a SINGLETON row for this bar's own name/location/tax rate.
-- Same last-write-wins rule as menu_items — one owner edits it, rarely.
create table if not exists bar_settings (
  id text primary key default 'main',
  bar_name text not null default 'My Bar',
  address text,
  phone text,
  currency text not null default '₹',
  tax_rate numeric not null default 0.05,
  receipt_footer text,
  updated_at timestamptz not null default now()
);

create or replace function upsert_bar_settings(
  p_bar_name text, p_address text, p_phone text, p_currency text,
  p_tax_rate numeric, p_receipt_footer text, p_updated_at timestamptz
) returns void as $$
begin
  insert into bar_settings (id, bar_name, address, phone, currency, tax_rate, receipt_footer, updated_at)
  values ('main', p_bar_name, p_address, p_phone, p_currency, p_tax_rate, p_receipt_footer, p_updated_at)
  on conflict (id) do update
  set bar_name = excluded.bar_name,
      address = excluded.address,
      phone = excluded.phone,
      currency = excluded.currency,
      tax_rate = excluded.tax_rate,
      receipt_footer = excluded.receipt_footer,
      updated_at = excluded.updated_at
  where bar_settings.updated_at < excluded.updated_at;
end;
$$ language plpgsql;

-- Menu items: last-write-wins guarded by updated_at, so an out-of-order
-- sync from a terminal that's been offline longer can't clobber a newer edit.
create or replace function upsert_menu_item(
  p_id uuid, p_name text, p_price numeric, p_category text, p_updated_at timestamptz
) returns void as $$
begin
  insert into menu_items (id, name, price, category, updated_at)
  values (p_id, p_name, p_price, p_category, p_updated_at)
  on conflict (id) do update
  set name = excluded.name,
      price = excluded.price,
      category = excluded.category,
      updated_at = excluded.updated_at
  where menu_items.updated_at < excluded.updated_at;
end;
$$ language plpgsql;
