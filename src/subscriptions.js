// subscriptions.js — Activación y suspensión REAL de suscripciones (basada en fechas, no en botones de demo)
const { pool } = require('./db');

const PLAN_DURATIONS = {
  COOP: { unit: 'months', amount: 1 },
  PRO: { unit: 'years', amount: 1 },
  GOLD: { unit: 'years', amount: 1 },
};

function addDuration(date, plan) {
  const d = new Date(date);
  const dur = PLAN_DURATIONS[plan] || PLAN_DURATIONS.COOP;
  if (dur.unit === 'months') d.setMonth(d.getMonth() + dur.amount);
  else d.setFullYear(d.getFullYear() + dur.amount);
  return d;
}

async function activateOrganization(orgId, plan) {
  const inicio = new Date();
  const fin = addDuration(inicio, plan);

  await pool.query(
    `UPDATE organizaciones
     SET plan = $1, estado_suscripcion = 'activo', suscripcion_inicio = $2, suscripcion_fin = $3
     WHERE id = $4`,
    [plan, inicio.toISOString(), fin.toISOString(), orgId]
  );

  await pool.query(
    `INSERT INTO notificaciones (organizacion_id, tipo, texto) VALUES ($1, 'pago', $2)`,
    [orgId, `Servicio activado automáticamente · Plan ${plan}. Vigente hasta ${fin.toLocaleDateString('es-CO')}.`]
  );

  return { plan, estado: 'activo', inicio: inicio.toISOString(), fin: fin.toISOString() };
}

async function checkExpirations() {
  const now = new Date().toISOString();
  const result = await pool.query(
    `SELECT id FROM organizaciones WHERE estado_suscripcion = 'activo' AND suscripcion_fin IS NOT NULL AND suscripcion_fin < $1`,
    [now]
  );

  for (const row of result.rows) {
    await pool.query(`UPDATE organizaciones SET estado_suscripcion = 'suspendido' WHERE id = $1`, [row.id]);
    await pool.query(
      `INSERT INTO notificaciones (organizacion_id, tipo, texto) VALUES ($1, 'suspension', $2)`,
      [row.id, 'Tu suscripción venció y el servicio fue suspendido automáticamente. Renueva tu pago para reactivarlo.']
    );
  }
  return result.rows.length;
}

async function markPending(orgId, plan) {
  await pool.query(`UPDATE organizaciones SET plan = $1, estado_suscripcion = 'pendiente' WHERE id = $2`, [plan, orgId]);
  await pool.query(
    `INSERT INTO notificaciones (organizacion_id, tipo, texto) VALUES ($1, 'pago', $2)`,
    [orgId, `Pago por transferencia notificado para el plan ${plan}. Verificaremos en menos de 24 horas.`]
  );
}

module.exports = { activateOrganization, checkExpirations, markPending };
