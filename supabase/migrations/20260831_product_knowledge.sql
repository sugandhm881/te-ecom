-- 2026-08-31 · The voice agent's product knowledge base (user: "make a document created by Claude and
-- use that document reference to explain benefit, ingredients etc of product").
-- One row per BASE formula; combos/kits match multiple rows through match_rx against the order's
-- line-item titles. `knowledge` is speakable text: what it is, hero ingredients and what each does,
-- how to use, expectations. Authored by Claude on the store's own catalog — the master human-readable
-- copy lives in docs/PRODUCT_KNOWLEDGE.md; edits here win at call time (vobiz_bridge caches 10 min).
create table if not exists product_knowledge_ecom (
  key        text primary key,
  title      text not null,
  match_rx   text not null,          -- case-insensitive regex tested against each order line title
  knowledge  text not null,
  updated_at timestamptz not null default now()
);
alter table product_knowledge_ecom enable row level security;
