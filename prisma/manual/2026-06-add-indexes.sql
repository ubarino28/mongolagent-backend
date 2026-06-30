-- orgId индексүүд — PROD дээр аюулгүй (IF NOT EXISTS, идемпотент).
-- Ажиллуулах: npx prisma db execute --schema prisma/schema.prisma --file prisma/manual/2026-06-add-indexes.sql
-- (Том хүснэгт дээр түр lock-оос сэргийлэхийг хүсвэл доорх мөр бүрийг CREATE INDEX CONCURRENTLY болгож,
--  тус тусад нь гараар ажиллуул — CONCURRENTLY нь transaction дотор ажиллахгүй.)

CREATE INDEX IF NOT EXISTS "TuruuUnanswered_orgId_resolved_idx" ON "TuruuUnanswered" ("orgId", "resolved");
CREATE INDEX IF NOT EXISTS "TuruuLead_orgId_createdAt_idx"       ON "TuruuLead" ("orgId", "createdAt");
CREATE INDEX IF NOT EXISTS "TuruuConsultation_orgId_idx"         ON "TuruuConsultation" ("orgId");
CREATE INDEX IF NOT EXISTS "TuruuKnowledge_orgId_active_idx"     ON "TuruuKnowledge" ("orgId", "active");
CREATE INDEX IF NOT EXISTS "TuruuStaff_orgId_idx"                ON "TuruuStaff" ("orgId");
CREATE INDEX IF NOT EXISTS "TuruuAppointment_orgId_date_idx"     ON "TuruuAppointment" ("orgId", "date");
CREATE INDEX IF NOT EXISTS "TuruuAppointment_staffId_idx"        ON "TuruuAppointment" ("staffId");
CREATE INDEX IF NOT EXISTS "TuruuMenuItem_orgId_isActive_idx"    ON "TuruuMenuItem" ("orgId", "isActive");
CREATE INDEX IF NOT EXISTS "TuruuTable_orgId_idx"                ON "TuruuTable" ("orgId");
CREATE INDEX IF NOT EXISTS "TuruuReservation_orgId_date_idx"     ON "TuruuReservation" ("orgId", "date");
CREATE INDEX IF NOT EXISTS "StoreCategory_orgId_idx"             ON "StoreCategory" ("orgId");
