-- One retirement row per withdrawing source, so an admin bringing a brief back
-- past one source leaves it withdrawn while another source's row remains
-- (services/memory/brief-retirement.ts). Every existing row keeps its briefId
-- and sourceId; the old key was unique on briefId alone, so the wider key holds
-- for them unchanged.
--
-- Every existing row is marked legacy: before this change a second source
-- leaving an already-withdrawn brief wrote no row, so an existing row cannot
-- prove it is the brief's only withdrawal and un-retire refuses it. The column
-- is added with default true to mark them, then defaults to false for new rows.

-- AlterTable
ALTER TABLE "brief_retirements" DROP CONSTRAINT "brief_retirements_pkey",
ADD CONSTRAINT "brief_retirements_pkey" PRIMARY KEY ("briefId", "sourceId");

ALTER TABLE "brief_retirements" ADD COLUMN "legacy" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "brief_retirements" ALTER COLUMN "legacy" SET DEFAULT false;
