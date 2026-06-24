"use strict";

// Чухал үйлдлүүдийг бүртгэнэ (best-effort — алдвал үндсэн үйлдлийг зогсоохгүй).
async function logAudit(prisma, req, action, target, meta) {
  try {
    await prisma.auditLog.create({
      data: {
        orgId: req.org.orgId,
        actor: req.org.name || req.org.slug || null,
        role: req.org.role || "owner",
        action,
        target: target != null ? String(target).slice(0, 120) : null,
        meta: meta || undefined,
      },
    });
  } catch { /* бүртгэлийн алдаа үндсэн урсгалд нөлөөлөхгүй */ }
}

module.exports = { logAudit };
