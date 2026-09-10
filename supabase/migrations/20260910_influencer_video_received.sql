-- ─────────────────────────────────────────────────────────────────────────────
-- "VIDEO RECEIVED" — the moment a partnered influencer actually delivers.
--
-- User, 2026-09-10: on a video card, when the influencer's status is Partnered,
-- show a "Video received" checkbox; once clicked it stays visible but goes
-- DISABLED, and the action lands in the activity feed.
--
-- Until now the card could say a product was sent and a payment was due, but
-- nothing recorded the delivery itself — the only signal was someone pasting a
-- reel URL, which happens later (or never, for a story or a private cut).
--
-- `video_received_at` is stored separately from the flag on purpose: the activity
-- line and any later "how long from product-sent to delivery" question need the
-- real moment, and a boolean cannot answer when.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.influencer_videos
    add column if not exists video_received    boolean     not null default false,
    add column if not exists video_received_at timestamptz;

comment on column public.influencer_videos.video_received is
    'The influencer has delivered the video. ONE-WAY: the API refuses to set this back to false once true, which is what makes the disabled checkbox in the UI mean something rather than just look locked.';
comment on column public.influencer_videos.video_received_at is
    'When it was marked received. Set by the server, never by the client.';

-- Partial index: the only question anyone asks of this column is "which partnered
-- videos are still outstanding", so the false rows are the ones worth indexing.
create index if not exists influencer_videos_awaiting_idx
    on public.influencer_videos (influencer_id)
    where video_received = false;
