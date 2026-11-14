-- DropForeignKey
ALTER TABLE "ingestion_jobs" DROP CONSTRAINT "ingestion_jobs_user_id_fkey";

-- DropForeignKey
ALTER TABLE "staging_items" DROP CONSTRAINT "staging_items_job_id_fkey";

-- DropForeignKey
ALTER TABLE "staging_items" DROP CONSTRAINT "staging_items_matched_trade_id_fkey";

-- DropForeignKey
ALTER TABLE "staging_items" DROP CONSTRAINT "staging_items_user_id_fkey";

-- DropForeignKey
ALTER TABLE "trades" DROP CONSTRAINT "trades_user_id_fkey";

-- AlterTable
ALTER TABLE "audit_logs" ALTER COLUMN "created_at_utc" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "trades" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "trades" ADD CONSTRAINT "trades_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staging_items" ADD CONSTRAINT "staging_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staging_items" ADD CONSTRAINT "staging_items_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "ingestion_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staging_items" ADD CONSTRAINT "staging_items_matched_trade_id_fkey" FOREIGN KEY ("matched_trade_id") REFERENCES "trades"("id") ON DELETE SET NULL ON UPDATE CASCADE;
