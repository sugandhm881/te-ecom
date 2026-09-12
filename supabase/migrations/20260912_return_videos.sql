-- RTO / RETURN VIDEOS (2026-09-12). User: "make a new dashboard for upload video with note … reason of making
-- this dashboard due to short goods received when shipment is RTO & Return … permission based … whenever we
-- need we download that video and make sure no max storage use for video and quality of video should be also
-- maintained."
--
-- STORAGE, with the project's real numbers: Supabase Pro includes 100 GB file storage (then $0.0213/GB/month)
-- and 250 GB egress (then $0.09/GB); the project uses ~113 MB across its other buckets today. The dashboard
-- re-encodes each video to 720p before upload (~10-15 MB a minute instead of 100-150 MB), so ~7,000 videos fit
-- inside the included 100 GB, and rows older than RETENTION_MONTHS (6) are purged nightly — see
-- purgeOldVideos() in app/api/return_videos.js, which deletes the file AND the row.
--
-- The bucket is PRIVATE (every other bucket in this project is public): a video is reachable only through the
-- dashboard, which hands out a signed URL valid for two minutes. 200 MB per file, video types only.

create table if not exists return_videos_ecom (
  id            bigserial primary key,
  marketplace   text not null,
  order_name    text,                      -- bare, no '#'
  awb           text,
  short_qty     integer,
  short_value   numeric,
  note          text,
  file_path     text,                      -- object path inside the return-videos bucket; null until uploaded
  file_size     bigint,
  original_size bigint,                    -- what the phone recorded, before the browser re-encode
  compressed    boolean not null default false,
  mime          text,
  status        text not null default 'pending',   -- pending → ready (a pending row with no file is swept nightly)
  uploaded_by   text,
  created_at    timestamptz not null default now()
);
create index if not exists return_videos_created_idx on return_videos_ecom (created_at desc);
create index if not exists return_videos_order_idx on return_videos_ecom (order_name);
alter table return_videos_ecom enable row level security;   -- service-role only, like every *_ecom table

-- The marketplace dropdown: the five asked for, and anyone with the permission can add more.
create table if not exists return_video_marketplaces_ecom (
  name       text primary key,
  added_by   text,
  created_at timestamptz not null default now()
);
alter table return_video_marketplaces_ecom enable row level security;
insert into return_video_marketplaces_ecom (name) values ('Amazon'), ('Flipkart'), ('Myntra'), ('Shopify'), ('Meesho')
  on conflict (name) do nothing;

-- The private bucket: 200 MB a file, video only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('return-videos', 'return-videos', false, 209715200,
        array['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska', 'video/3gpp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
                               allowed_mime_types = excluded.allowed_mime_types;
