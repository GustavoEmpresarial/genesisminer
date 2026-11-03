-- TopIdle vote webhook idempotency (eventId) + nextVoteAt per player.
CREATE TABLE IF NOT EXISTS "topidle_vote_events" (
    "event_id" TEXT NOT NULL,
    "user_id" INTEGER NOT NULL,
    "voted_at" TIMESTAMPTZ,
    "next_vote_at" TIMESTAMPTZ,
    "created_at" BIGINT NOT NULL,
    CONSTRAINT "topidle_vote_events_pkey" PRIMARY KEY ("event_id")
);

CREATE INDEX "topidle_vote_events_user_id_created_at_idx"
    ON "topidle_vote_events" ("user_id", "created_at" DESC);
