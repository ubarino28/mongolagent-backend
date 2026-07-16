"use strict";
// Багийн гишүүд (StaffMember) — app талын эрхийн удирдлага.
// website.mongolagent.mn (store.routes.js /staff)-тай ИЖИЛ логик, ижил StaffMember модель —
// нэг газраас үүсгэсэн ажилтан хоёр талд ижил эрхээр нэвтэрнэ.
// Замын нэр /team — учир нь /client/staff нь ЦАГ ЗАХИАЛГЫН мастеруудад (TuruuStaff) аль хэдийн эзэлэгдсэн.
// Auth-ийг эцэг router (client.routes.js) clientAuthMiddleware-ээр тавьсан тул req.org бэлэн.
const express = require("express");
const bcrypt = require("bcryptjs");
const { getPrisma } = require("../../lib/db");
const { logAudit } = require("../../services/audit.service");
// Багийн удирдлага БҮХЭЛДЭЭ зөвхөн эзэмшигчид (ажилтан өөр ажилтан үүсгэж эрхээ өсгөхөөс сэргийлнэ)
const { requireOwner } = require("../../lib/rbac");

const router = express.Router();

const SAFE = { id: true, name: true, email: true, role: true, status: true, createdAt: true };
const normRole = (r) => (r === "viewer" ? "viewer" : "staff");

router.get("/team", requireOwner, async (req, res) => {
  try {
    const prisma = getPrisma();
    const team = await prisma.staffMember.findMany({
      where: { orgId: req.org.orgId },
      orderBy: { createdAt: "asc" },
      select: SAFE,
    });
    res.json({ team });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

router.post("/team", requireOwner, async (req, res) => {
  try {
    const { name, email, password, role } = req.body || {};
    if (!name || !email || !password) return res.status(400).json({ error: "Нэр, имэйл, нууц үг шаардлагатай" });
    if (String(password).length < 6) return res.status(400).json({ error: "Нууц үг хамгийн багадаа 6 тэмдэгт" });
    const prisma = getPrisma();
    // Имэйл нь өөр org эсвэл өөр ажилтанд бүртгэлтэй эсэхийг шалгана (нэвтрэлт зөрөхөөс сэргийлнэ)
    const lowEmail = String(email).toLowerCase().trim();
    const [dupOrg, dupStaff] = await Promise.all([
      prisma.organization.findUnique({ where: { email: lowEmail }, select: { id: true } }),
      prisma.staffMember.findUnique({ where: { email: lowEmail }, select: { id: true } }),
    ]);
    if (dupOrg || dupStaff) return res.status(409).json({ error: "Энэ имэйл аль хэдийн бүртгэлтэй байна" });
    const passwordHash = await bcrypt.hash(String(password), 10);
    const created = await prisma.staffMember.create({
      data: { orgId: req.org.orgId, name: String(name).slice(0, 80), email: lowEmail, passwordHash, role: normRole(role) },
      select: SAFE,
    });
    await logAudit(prisma, req, "staff.create", created.email, { role: created.role });
    res.json({ member: created });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

router.patch("/team/:id", requireOwner, async (req, res) => {
  try {
    const { role, status, password } = req.body || {};
    const prisma = getPrisma();
    // orgId-аар шүүнэ — өөр байгууллагын ажилтанд хүрэхээс сэргийлнэ
    const member = await prisma.staffMember.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!member) return res.status(404).json({ error: "Ажилтан олдсонгүй" });
    const data = {};
    if (role !== undefined) data.role = normRole(role);
    if (status !== undefined) data.status = status === "disabled" ? "disabled" : "active";
    if (password) {
      if (String(password).length < 6) return res.status(400).json({ error: "Нууц үг хамгийн багадаа 6 тэмдэгт" });
      data.passwordHash = await bcrypt.hash(String(password), 10);
    }
    const updated = await prisma.staffMember.update({ where: { id: member.id }, data, select: SAFE });
    await logAudit(prisma, req, "staff.update", member.email, data.passwordHash ? { reset: true } : { role: data.role, status: data.status });
    res.json({ member: updated });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

router.delete("/team/:id", requireOwner, async (req, res) => {
  try {
    const prisma = getPrisma();
    const member = await prisma.staffMember.findFirst({ where: { id: req.params.id, orgId: req.org.orgId } });
    if (!member) return res.status(404).json({ error: "Ажилтан олдсонгүй" });
    await prisma.staffMember.delete({ where: { id: member.id } });
    await logAudit(prisma, req, "staff.delete", member.email);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: (console.error("[err]", e && e.message), "Серверийн алдаа гарлаа") }); }
});

module.exports = router;
