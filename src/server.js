// server.js — Fondos Sin Fronteras AI · Backend real
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('node:crypto');

const { db, bcrypt } = require('./db');
const { signToken, requireAuth } = require('./auth');
const { activateOrganization, checkExpirations, markPending } = require('./subscriptions');
const { getClient, extraerTexto, parsearJSON, ANTHROPIC_MODEL } = require('./claude');
const { streamProjectPDF } = require('./pdf');

const app = express();
app.use(cors());
app.use(express.json());

const PLAN_PRICES = { COOP: 97, PRO: 780, GOLD: 1550 };

// =====================================================================
// Salud del servicio
// =====================================================================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, servicio: 'Fondos Sin Fronteras AI API', hora: new Date().toISOString() });
});

// =====================================================================
// SORY — chat real con Claude (antes simulado en el navegador)
// =====================================================================
app.post('/api/sory/chat', requireAuth, async (req, res) => {
  const { mensaje, historial } = req.body || {};
  if (!mensaje || typeof mensaje !== 'string' || !mensaje.trim()) {
    return res.status(400).json({ error: 'Falta el campo "mensaje" (texto) en el cuerpo de la solicitud.' });
  }
  try {
    const anthropic = getClient();

    const messages = [];
    if (Array.isArray(historial)) {
      for (const h of historial) {
        if (h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string') {
          messages.push({ role: h.role, content: h.content });
        }
      }
    }
    messages.push({ role: 'user', content: mensaje });

    const respuesta = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      system: 'Eres SORY, la asistente de inteligencia artificial de Fondos Sin Fronteras AI. Ayudas a organizaciones sociales a formular proyectos y acceder a cooperación internacional. Respondes en español, de forma clara, honesta y práctica. Si no tienes información verificada sobre algo, lo dices explícitamente en vez de inventar datos.',
      messages,
    });

    const texto = extraerTexto(respuesta);
    res.status(200).json({ respuesta: texto });
  } catch (err) {
    console.error('[sory/chat] error:', err);
    res.status(500).json({ error: err.message || 'Error al consultar a SORY.' });
  }
});

// =====================================================================
// Búsqueda de convocatorias en tiempo real con IA + búsqueda web
// =====================================================================
app.post('/api/convocatorias/buscar-ia', requireAuth, async (req, res) => {
  const { consulta } = req.body || {};
  if (!consulta || typeof consulta !== 'string' || !consulta.trim()) {
    return res.status(400).json({ error: 'Falta el campo "consulta" (texto) en el cuerpo de la solicitud.' });
  }
  try {
    const anthropic = getClient();

    const respuesta = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: [
        'Eres un buscador de convocatorias, fondos y becas de cooperación internacional VIGENTES.',
        'Busca en la web información real y actual, priorizando fuentes oficiales: organismos cooperantes,',
        'Naciones Unidas, Unión Europea, BID, USAID, fundaciones privadas y gobiernos.',
        'Responde ÚNICAMENTE con un JSON válido, sin texto adicional antes o después, exactamente con esta forma:',
        '{ "resultados": [ { "nombre": "...", "cooperante": "...", "pais": "...", "sector": "...",',
        '"monto": "...", "fecha_cierre": "...", "resumen": "...", "url": "..." } ] }',
        'Máximo 6 resultados. Si no encuentras nada relevante o vigente, responde { "resultados": [] }.',
      ].join(' '),
      messages: [{ role: 'user', content: consulta }],
    });

    const texto = extraerTexto(respuesta);
    const payload = parsearJSON(texto);

    if (!payload || !Array.isArray(payload.resultados)) {
      throw new Error('El JSON devuelto no tiene la forma esperada ({ "resultados": [...] }).');
    }

    res.status(200).json(payload);
  } catch (err) {
    console.error('[convocatorias/buscar-ia] error:', err);
    res.status(500).json({ error: err.message || 'Error al buscar convocatorias con IA.' });
  }
});

// =====================================================================
// Autenticación
// =====================================================================
app.post('/api/auth/registro', (req, res) => {
  const { nombreOrganizacion, pais, sector, nombreUsuario, email, password } = req.body || {};
  if (!nombreOrganizacion || !email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Faltan campos requeridos o la contraseña tiene menos de 8 caracteres.' });
  }
  const existente = db.prepare('SELECT id FROM usuarios WHERE email = ?').get(email);
  if (existente) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

  const org = db.prepare(`INSERT INTO organizaciones (nombre, pais, sector) VALUES (?, ?, ?)`)
    .run(nombreOrganizacion, pais || 'Colombia', sector || null);

  const hash = bcrypt.hashSync(password, 10);
  const user = db.prepare(`
    INSERT INTO usuarios (organizacion_id, nombre, email, password_hash, rol) VALUES (?, ?, ?, ?, 'administrador')
  `).run(org.lastInsertRowid, nombreUsuario || 'Administrador', email, hash);

  const usuario = { id: user.lastInsertRowid, organizacion_id: org.lastInsertRowid, rol: 'administrador', email };
  const token = signToken(usuario);
  res.status(201).json({ token, organizacionId: org.lastInsertRowid, usuarioId: user.lastInsertRowid });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const usuario = db.prepare('SELECT * FROM usuarios WHERE email = ?').get(email);
  if (!usuario || !bcrypt.compareSync(password || '', usuario.password_hash)) {
    return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
  const token = signToken(usuario);
  res.json({ token, organizacionId: usuario.organizacion_id, usuarioId: usuario.id });
});

// =====================================================================
// Organización / perfil propio
// =====================================================================
app.get('/api/organizaciones/me', requireAuth, (req, res) => {
  const org = db.prepare('SELECT * FROM organizaciones WHERE id = ?').get(req.user.org);
  if (!org) return res.status(404).json({ error: 'Organización no encontrada.' });
  res.json(org);
});

// =====================================================================
// Convocatorias
// =====================================================================
app.get('/api/convocatorias', (req, res) => {
  const rows = db.prepare("SELECT * FROM convocatorias WHERE estado_verificacion != 'retirada' ORDER BY fecha_cierre ASC").all();
  const parsed = rows.map(r => ({
    ...r,
    requisitos: JSON.parse(r.requisitos || '[]'),
    documentos: JSON.parse(r.documentos || '[]'),
  }));
  res.json(parsed);
});

app.get('/api/convocatorias/:id', (req, res) => {
  const r = db.prepare('SELECT * FROM convocatorias WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Convocatoria no encontrada.' });
  res.json({ ...r, requisitos: JSON.parse(r.requisitos || '[]'), documentos: JSON.parse(r.documentos || '[]') });
});

app.post('/api/convocatorias/:id/reportes', requireAuth, (req, res) => {
  const conv = db.prepare('SELECT id FROM convocatorias WHERE id = ?').get(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Convocatoria no encontrada.' });
  db.prepare("UPDATE convocatorias SET estado_verificacion = 'en_revision' WHERE id = ?").run(req.params.id);
  res.json({ ok: true, mensaje: 'Reporte recibido. La convocatoria queda en revisión.' });
});

// ---- Favoritas ----
app.post('/api/convocatorias/:id/favorito', requireAuth, (req, res) => {
  db.prepare('INSERT OR IGNORE INTO favoritos (usuario_id, convocatoria_id) VALUES (?, ?)')
    .run(req.user.sub, req.params.id);
  res.json({ ok: true, favorito: true });
});
app.delete('/api/convocatorias/:id/favorito', requireAuth, (req, res) => {
  db.prepare('DELETE FROM favoritos WHERE usuario_id = ? AND convocatoria_id = ?').run(req.user.sub, req.params.id);
  res.json({ ok: true, favorito: false });
});
app.get('/api/favoritos', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.* FROM favoritos f JOIN convocatorias c ON c.id = f.convocatoria_id WHERE f.usuario_id = ?
  `).all(req.user.sub);
  res.json(rows.map(r => ({ ...r, requisitos: JSON.parse(r.requisitos || '[]'), documentos: JSON.parse(r.documentos || '[]') })));
});

// =====================================================================
// Proyectos (Constructor Inteligente)
// =====================================================================
app.post('/api/proyectos', requireAuth, (req, res) => {
  const { titulo, convocatoriaId, diagnostico, objetivoGeneral, objetivosEspecificos, resultados, presupuesto, cronograma } = req.body || {};
  if (!titulo) return res.status(400).json({ error: 'El proyecto necesita un título.' });
  const info = db.prepare(`
    INSERT INTO proyectos (organizacion_id, convocatoria_id, titulo, diagnostico, objetivo_general, objetivos_especificos, resultados, presupuesto, cronograma)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.org, convocatoriaId || null, titulo, diagnostico || '', objetivoGeneral || '',
    JSON.stringify(objetivosEspecificos || []), JSON.stringify(resultados || []),
    JSON.stringify(presupuesto || []), JSON.stringify(cronograma || [])
  );
  res.status(201).json({ id: info.lastInsertRowid });
});

app.get('/api/proyectos', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM proyectos WHERE organizacion_id = ? ORDER BY actualizado_en DESC').all(req.user.org);
  res.json(rows);
});

app.patch('/api/proyectos/:id', requireAuth, (req, res) => {
  const proyecto = db.prepare('SELECT * FROM proyectos WHERE id = ? AND organizacion_id = ?').get(req.params.id, req.user.org);
  if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado.' });
  const campos = ['titulo', 'diagnostico', 'objetivo_general', 'estado'];
  const sets = [];
  const vals = [];
  for (const c of campos) {
    if (req.body[c] !== undefined) { sets.push(`${c} = ?`); vals.push(req.body[c]); }
  }
  for (const jsonField of ['objetivos_especificos', 'resultados', 'presupuesto', 'cronograma']) {
    if (req.body[jsonField] !== undefined) { sets.push(`${jsonField} = ?`); vals.push(JSON.stringify(req.body[jsonField])); }
  }
  sets.push("actualizado_en = datetime('now')");
  vals.push(req.params.id);
  db.prepare(`UPDATE proyectos SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ ok: true });
});

app.get('/api/proyectos/:id/pdf', requireAuth, (req, res) => {
  const proyecto = db.prepare('SELECT * FROM proyectos WHERE id = ? AND organizacion_id = ?').get(req.params.id, req.user.org);
  if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado.' });
  const org = db.prepare('SELECT * FROM organizaciones WHERE id = ?').get(req.user.org);
  let convocatoriaNombre = null;
  if (proyecto.convocatoria_id) {
    const c = db.prepare('SELECT nombre FROM convocatorias WHERE id = ?').get(proyecto.convocatoria_id);
    convocatoriaNombre = c ? c.nombre : null;
  }
  streamProjectPDF(res, { ...proyecto, convocatoria_nombre: convocatoriaNombre }, org);
});

// =====================================================================
// Notificaciones
// =====================================================================
app.get('/api/notificaciones', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM notificaciones WHERE organizacion_id = ? ORDER BY creado_en DESC LIMIT 30').all(req.user.org);
  res.json(rows);
});
app.post('/api/notificaciones/:id/leida', requireAuth, (req, res) => {
  db.prepare('UPDATE notificaciones SET leida = 1 WHERE id = ? AND organizacion_id = ?').run(req.params.id, req.user.org);
  res.json({ ok: true });
});

// =====================================================================
// Suscripción y pagos
// =====================================================================
app.get('/api/suscripcion', requireAuth, (req, res) => {
  checkExpirations();
  const org = db.prepare('SELECT plan, estado_suscripcion, suscripcion_inicio, suscripcion_fin FROM organizaciones WHERE id = ?').get(req.user.org);
  res.json(org);
});

app.get('/api/transacciones', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM transacciones WHERE organizacion_id = ? ORDER BY creado_en DESC LIMIT 30').all(req.user.org);
  res.json(rows);
});

app.post('/api/pagos/iniciar', requireAuth, (req, res) => {
  const { plan, metodo } = req.body || {};
  if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Plan inválido.' });
  if (!['paypal', 'nequi', 'pse', 'transferencia'].includes(metodo)) return res.status(400).json({ error: 'Método de pago inválido.' });

  const referencia = crypto.randomUUID();
  db.prepare(`
    INSERT INTO transacciones (organizacion_id, plan, monto, metodo, estado, referencia_externa)
    VALUES (?, ?, ?, ?, 'pendiente', ?)
  `).run(req.user.org, plan, String(PLAN_PRICES[plan]), metodo, referencia);

  if (metodo === 'transferencia' || metodo === 'nequi') {
    markPending(req.user.org, plan);
  }

  res.json({ referencia, monto: PLAN_PRICES[plan], plan, metodo, estado: 'pendiente' });
});

app.post('/api/pagos/webhook/paypal', express.json({ type: '*/*' }), (req, res) => {
  const evento = req.body;
  console.log('[webhook paypal] evento recibido:', JSON.stringify(evento).slice(0, 300));
  res.status(200).json({ recibido: true });
});

app.post('/api/pagos/confirmar', requireAuth, (req, res) => {
  const { plan } = req.body || {};
  if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Plan inválido.' });
  const resultado = activateOrganization(req.user.org, plan);
  db.prepare(`
    UPDATE transacciones SET estado = 'confirmada' WHERE organizacion_id = ? AND plan = ? AND estado = 'pendiente'
  `).run(req.user.org, plan);
  res.json(resultado);
});

// =====================================================================
// Tarea periódica real: revisa vencimientos cada 60 segundos
// =====================================================================
checkExpirations();
setInterval(checkExpirations, 60 * 1000);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Fondos Sin Fronteras AI API escuchando en http://localhost:${PORT}`);
});

module.exports = app;
