CREATE TABLE "accrual_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"wallet" text NOT NULL,
	"from_block" bigint NOT NULL,
	"to_block" bigint NOT NULL,
	"requested" numeric(78, 0) NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"capped_by" text,
	"payment_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'planned' NOT NULL,
	"source" text DEFAULT 'keeper' NOT NULL,
	"tx_hash" text,
	"log_index" integer,
	"block_number" bigint,
	"block_time" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chain_binding" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"chain_id" integer NOT NULL,
	"bound_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cursors" (
	"chain_id" integer NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"start_block" bigint NOT NULL,
	"last_block" bigint,
	"last_hash" text,
	"observed_head" bigint,
	"last_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "cursors_chain_id_name_pk" PRIMARY KEY("chain_id","name")
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"kind" text NOT NULL,
	"token" text NOT NULL,
	"asset" text,
	"amount" numeric(78, 0) NOT NULL,
	"reason" text,
	"oracle_status" smallint,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	CONSTRAINT "deliveries_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"wallet" text NOT NULL,
	"linked_block" bigint NOT NULL,
	"linked_at" timestamp with time zone,
	"linked_tx" text NOT NULL,
	"linked_log_index" integer NOT NULL,
	"unlinked_block" bigint,
	"unlinked_at" timestamp with time zone,
	"unlinked_tx" text,
	"unlinked_log_index" integer
);
--> statement-breakpoint
CREATE TABLE "mixes" (
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"kind" text NOT NULL,
	"legs" jsonb NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	CONSTRAINT "mixes_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "oracle_snapshots" (
	"chain_id" integer NOT NULL,
	"feed" text NOT NULL,
	"asset" text,
	"label" text,
	"round_id" numeric(78, 0),
	"answer" numeric(78, 0),
	"decimals" smallint NOT NULL,
	"updated_at" timestamp with time zone,
	"status" smallint,
	"price_1e18" numeric(78, 0),
	"block_number" bigint NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oracle_snapshots_pkey" PRIMARY KEY("feed","observed_at")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"chain_id" integer NOT NULL,
	"wallet" text NOT NULL,
	"account" text NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"counterparty" text NOT NULL,
	"excluded_reason" text,
	"delta" numeric(78, 0) NOT NULL,
	"round_to" smallint NOT NULL,
	"multiplier" smallint NOT NULL,
	"batch_id" uuid,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_pkey" PRIMARY KEY("tx_hash","log_index","block_time")
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"round_to" smallint NOT NULL,
	"multiplier" smallint NOT NULL,
	"weekly_cap" numeric(78, 0) NOT NULL,
	"enabled" boolean NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	CONSTRAINT "rules_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "sweep_fills" (
	"chain_id" integer NOT NULL,
	"asset" text NOT NULL,
	"usdg_in" numeric(78, 0) NOT NULL,
	"fee" numeric(78, 0) NOT NULL,
	"tokens_out" numeric(78, 0) NOT NULL,
	"oracle_price_1e18" numeric(78, 0),
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	CONSTRAINT "sweep_fills_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "sweeps" (
	"chain_id" integer NOT NULL,
	"account" text NOT NULL,
	"epoch" bigint NOT NULL,
	"usdg" numeric(78, 0) NOT NULL,
	"block_number" bigint NOT NULL,
	"block_time" timestamp with time zone,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	CONSTRAINT "sweeps_tx_hash_log_index_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "universe" (
	"chain_id" integer NOT NULL,
	"token" text NOT NULL,
	"source_id" text,
	"symbol" text NOT NULL,
	"name" text,
	"decimals" smallint,
	"isin" text,
	"status" text,
	"current_multiplier" text,
	"pending_multiplier" text,
	"trading_capabilities" jsonb,
	"logo_url" text,
	"proposal" jsonb,
	"fetched_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "universe_chain_id_token_pk" PRIMARY KEY("chain_id","token")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "accrual_batches_log_idx" ON "accrual_batches" USING btree ("tx_hash","log_index") WHERE "accrual_batches"."tx_hash" is not null;--> statement-breakpoint
CREATE INDEX "accrual_batches_account_idx" ON "accrual_batches" USING btree ("account","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "accrual_batches_wallet_idx" ON "accrual_batches" USING btree ("wallet","to_block" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deliveries_account_block_idx" ON "deliveries" USING btree ("account","block_number" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "deliveries_tx_idx" ON "deliveries" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "links_linked_log_idx" ON "links" USING btree ("linked_tx","linked_log_index");--> statement-breakpoint
CREATE INDEX "links_account_idx" ON "links" USING btree ("account","linked_block" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "links_wallet_idx" ON "links" USING btree ("wallet","linked_block" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "mixes_account_block_idx" ON "mixes" USING btree ("account","block_number" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "oracle_snapshots_asset_idx" ON "oracle_snapshots" USING btree ("asset","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_account_time_idx" ON "payments" USING btree ("account","block_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "payments_wallet_block_idx" ON "payments" USING btree ("wallet","block_number");--> statement-breakpoint
CREATE INDEX "rules_account_block_idx" ON "rules" USING btree ("account","block_number" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "sweep_fills_tx_idx" ON "sweep_fills" USING btree ("tx_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "sweeps_account_epoch_idx" ON "sweeps" USING btree ("chain_id","account","epoch");--> statement-breakpoint
CREATE INDEX "sweeps_account_block_idx" ON "sweeps" USING btree ("account","block_number" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "universe_symbol_idx" ON "universe" USING btree ("symbol");