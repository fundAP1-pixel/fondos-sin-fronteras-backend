// server.js — Fondos Sin Fronteras AI · Backend real (PostgreSQL)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('node:crypto');

const { pool, bcrypt, initDb } = require('./db');
const { signToken, requireAuth } = require('./auth');
const { activateOrganization, checkExpirations, markPending } = require('./subscriptions');
const { streamProjectPDF } = require('./pdf');

const app = express();
app.use(cors());
app.use(express.json());

const PLAN_PRICES = { COOP: 97, PRO: 780, GOLD: 1550 };

function asyncRoute(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(err);
    res.status(500).json({ error: 'Error interno del servidor.' });
  });
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, servicio: 'Fondos Sin Fronteras AI API', hora: new Date().toISOString() });
});

app.post('/api/auth/registro', asyncRoute(async (req, res) => {
  const { nombreOrganizacion, pais, sector, nombreUsuario, email, password } = req.body || {};
  if (!nombreOrganizacion || !email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Faltan campos requeridos o la contraseña tiene menos de 8 caracteres.' });
  }
  const existente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
  if (existente.rows.length) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

  const org = await pool.query(
    `INSERT INTO organizaciones (nombre, pais, sector) VALUES ($1, $2, $3) RETURNING id`,
    [nombreOrganizacion, pais || 'Colombia', sector || null]
  );
  const orgId = org.rows[0].id;

  const hash = bcrypt.hashSync(password, 10);
  const user = await pool.query(
    `INSERT INTO usuarios (organizacion_id, nombre, email, password_hash, rol)
     VALUES ($1, $2, $3, $4, 'administrador') RETURNING id`,
    [orgId, nombreUsuario || 'Administrador', email, hash]
  );
  const userId = user.rows[0].id;

  const usuario = { id: userId, organizacion_id: orgId, rol: 'administrador', email };
  const token = signToken(usuario);
  res.status(201).json({ token, organizacionId: orgId, usuarioId: userId });
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const { email, password } = req.body || {};
  const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
  const usuario = result.rows[0];
  if (!usuario || !bcrypt.compareSync(password || '', usuario.password_hash)) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  const token = signToken(usuario);
  res.json({ token, organizacionId: usuario.organizacion_id, usuarioId: usuario.id });
}));

app.get('/api/organizaciones/me', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM organizaciones WHERE id = $1', [req.user.org]);
  const org = result.rows[0];
  if (!org) return res.status(404).json({ error: 'Organización no encontrada.' });
  res.json(org);
}));

app.get('/api/convocatorias', asyncRoute(async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM convocatorias WHERE estado_verificacion != 'retirada' ORDER BY fecha_cierre ASC"
  );
  const parsed = result.rows.map(r => ({
    ...r,
    requisitos: JSON.parse(r.requisitos || '[]'),
    documentos: JSON.parse(r.documentos || '[]'),
  }));
  res.json(parsed);
}));

app.get('/api/convocatorias/:id', asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM convocatorias WHERE id = $1', [req.params.id]);
  const r = result.rows[0];
  if (!r) return res.status(404).json({ error: 'Convocatoria no encontrada.' });
  res.json({ ...r, requisitos: JSON.parse(r.requisitos || '[]'), documentos: JSON.parse(r.documentos || '[]') });
}));

app.post('/api/convocatorias/:id/reportes', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT id FROM convocatorias WHERE id = $1', [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Convocatoria no encontrada.' });
  await pool.query("UPDATE convocatorias SET estado_verificacion = 'en_revision' WHERE id = $1", [req.params.id]);
  res.json({ ok: true, mensaje: 'Reporte recibido. La convocatoria queda en revisión.' });
}));

app.post('/api/convocatorias/:id/favorito', requireAuth, asyncRoute(async (req, res) => {
  await pool.query(
    'INSERT INTO favoritos (usuario_id, convocatoria_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [req.user.sub, req.params.id]
  );
  res.json({ ok: true, favorito: true });
}));
app.delete('/api/convocatorias/:id/favorito', requireAuth, asyncRoute(async (req, res) => {
  await pool.query('DELETE FROM favoritos WHERE usuario_id = $1 AND convocatoria_id = $2', [req.user.sub, req.params.id]);
  res.json({ ok: true, favorito: false });
}));
app.get('/api/favoritos', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT c.* FROM favoritos f JOIN convocatorias c ON c.id = f.convocatoria_id WHERE f.usuario_id = $1`,
    [req.user.sub]
  );
  res.json(result.rows.map(r => ({ ...r, requisitos: JSON.parse(r.requisitos || '[]'), documentos: JSON.parse(r.documentos || '[]') })));
}));

app.post('/api/proyectos', requireAuth, asyncRoute(async (req, res) => {
  const { titulo, convocatoriaId, diagnostico, objetivoGeneral, objetivosEspecificos, resultados, presupuesto, cronograma } = req.body || {};
  if (!titulo) return res.status(400).json({ error: 'El proyecto necesita un título.' });
  const result = await pool.query(
    `INSERT INTO proyectos
      (organizacion_id, convocatoria_id, titulo, diagnostico, objetivo_general, objetivos_especificos, resultados, presupuesto, cronograma)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [
      req.user.org, convocatoriaId || null, titulo, diagnostico || '', objetivoGeneral || '',
      JSON.stringify(objetivosEspecificos || []), JSON.stringify(resultados || []),
      JSON.stringify(presupuesto || []), JSON.stringify(cronograma || [])
    ]
  );
  res.status(201).json({ id: result.rows[0].id });
}));

app.get('/api/proyectos', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM proyectos WHERE organizacion_id = $1 ORDER BY actualizado_en DESC', [req.user.org]);
  res.json(result.rows);
}));

app.patch('/api/proyectos/:id', requireAuth, asyncRoute(async (req, res) => {
  const existing = await pool.query('SELECT * FROM proyectos WHERE id = $1 AND organizacion_id = $2', [req.params.id, req.user.org]);
  if (!existing.rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado.' });

  const campos = ['titulo', 'diagnostico', 'objetivo_general', 'estado'];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const c of campos) {
    if (req.body[c] !== undefined) { sets.push(`${c} = $${i++}`); vals.push(req.body[c]); }
  }
  for (const jsonField of ['objetivos_especificos', 'resultados', 'presupuesto', 'cronograma']) {
    if (req.body[jsonField] !== undefined) { sets.push(`${jsonField} = $${i++}`); vals.push(JSON.stringify(req.body[jsonField])); }
  }
  sets.push("actualizado_en = now()");
  vals.push(req.params.id);
  await pool.query(`UPDATE proyectos SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  res.json({ ok: true });
}));

app.get('/api/proyectos/:id/pdf', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM proyectos WHERE id = $1 AND organizacion_id = $2', [req.params.id, req.user.org]);
  const proyecto = result.rows[0];
  if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado.' });

  const orgResult = await pool.query('SELECT * FROM organizaciones WHERE id = $1', [req.user.org]);
  const org = orgResult.rows[0];

  let convocatoriaNombre = null;
  if (proyecto.convocatoria_id) {
    const c = await pool.query('SELECT nombre FROM convocatorias WHERE id = $1', [proyecto.convocatoria_id]);
    convocatoriaNombre = c.rows[0] ? c.rows[0].nombre : null;
  }
  streamProjectPDF(res, { ...proyecto, convocatoria_nombre: convocatoriaNombre }, org);
}));

app.get('/api/notificaciones', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM notificaciones WHERE organizacion_id = $1 ORDER BY creado_en DESC LIMIT 30', [req.user.org]);
  res.json(result.rows);
}));
app.post('/api/notificaciones/:id/leida', requireAuth, asyncRoute(async (req, res) => {
  await pool.query('UPDATE notificaciones SET leida = 1 WHERE id = $1 AND organizacion_id = $2', [req.params.id, req.user.org]);
  res.json({ ok: true });
}));

app.get('/api/suscripcion', requireAuth, asyncRoute(async (req, res) => {
  await checkExpirations();
  const result = await pool.query(
    'SELECT plan, estado_suscripcion, suscripcion_inicio, suscripcion_fin FROM organizaciones WHERE id = $1',
    [req.user.org]
  );
  res.json(result.rows[0]);
}));

app.get('/api/transacciones', requireAuth, asyncRoute(async (req, res) => {
  const result = await pool.query('SELECT * FROM transacciones WHERE organizacion_id = $1 ORDER BY creado_en DESC LIMIT 30', [req.user.org]);
  res.json(result.rows);
}));

app.post('/api/pagos/iniciar', requireAuth, asyncRoute(async (req, res) => {
  const { plan, metodo } = req.body || {};
  if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Plan inválido.' });
  if (!['paypal', 'nequi', 'pse', 'transferencia'].includes(metodo)) return res.status(400).json({ error: 'Método de pago inválido.' });

  const referencia = crypto.randomUUID();
  await pool.query(
    `INSERT INTO transacciones (organizacion_id, plan, monto, metodo, estado, referencia_externa)
     VALUES ($1, $2, $3, $4, 'pendiente', $5)`,
    [req.user.org, plan, String(PLAN_PRICES[plan]), metodo, referencia]
  );

  if (metodo === 'transferencia' || metodo === 'nequi') {
    await markPending(req.user.org, plan);
  }

  res.json({ referencia, monto: PLAN_PRICES[plan], plan, metodo, estado: 'pendiente' });
}));

app.post('/api/pagos/webhook/paypal', express.json({ type: '*/*' }), (req, res) => {
  const evento = req.body;
  console.log('[webhook paypal] evento recibido:', JSON.stringify(evento).slice(0, 300));
  res.status(200).json({ recibido: true });
});

app.post('/api/pagos/confirmar', requireAuth, asyncRoute(async (req, res) => {
  const { plan } = req.body || {};
  if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Plan inválido.' });
  const resultado = await activateOrganization(req.user.org, plan);
  await pool.query(
    `UPDATE transacciones SET estado = 'confirmada' WHERE organizacion_id = $1 AND plan = $2 AND estado = 'pendiente'`,
    [req.user.org, plan]
  );
  res.json(resultado);
}));

const PORT = process.env.PORT || 4000;

initDb()
  .then(async () => {
    await checkExpirations();
    setInterval(checkExpirations, 60 * 1000);
    app.listen(PORT, () => {
      console.log(`Fondos Sin Fronteras AI API escuchando en http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('Error inicializando la base de datos:', err);
    process.exit(1);
  });

module.exports = app;
