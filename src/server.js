// server.js — Fondos Sin Fronteras AI · Backend real (PostgreSQL)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('node:crypto');

const { pool, bcrypt, initDb, obtenerUsoIA, incrementarUsoIA } = require('./db');
const { signToken, requireAuth } = require('./auth');
const { activateOrganization, checkExpirations, markPending } = require('./subscriptions');
const { getClient, extraerTexto, repararJSON, ANTHROPIC_MODEL } = require('./claude');
const { streamProjectPDF } = require('./pdf');

const app = express();
app.use(cors());
app.use(express.json());

const PLAN_PRICES = { COOP: 97, PRO: 780, GOLD: 1550 };

// Correos autorizados como administradores de la plataforma (no de una fundación, sino del sistema completo).
const SUPERADMIN_EMAILS = ['aldijuntos@hotmail.com'];

function requireSuperAdmin(req, res, next) {
  if (!req.user || !req.user.email || !SUPERADMIN_EMAILS.includes(req.user.email.toLowerCase())) {
    return res.status(403).json({ error: 'No tienes permisos de administradora de la plataforma.' });
  }
  next();
}
// Límites mensuales de uso de IA (SORY + buscador con IA, comparten el mismo contador).
// Un plan que NO aparezca aquí (PRO, GOLD, Empresarial) se considera ILIMITADO.
const LIMITES_PLAN_IA = { GRATIS: 15, COOP: 300 };

/**
 * Middleware: revisa si la organización ya alcanzó su límite mensual de IA según su plan.
 * Si lo alcanzó, responde 429 sin gastar créditos de Anthropic. Si no, deja pasar.
 */
async function verificarLimiteIA(req, res, next) {
  try {
    const { rows } = await pool.query('SELECT plan FROM organizaciones WHERE id = $1', [req.user.org]);
    const plan = rows[0] ? rows[0].plan : 'GRATIS';
    const limite = LIMITES_PLAN_IA[plan]; // undefined = ilimitado
    if (limite !== undefined) {
      const usado = await obtenerUsoIA(req.user.org);
      if (usado >= limite) {
        return res.status(429).json({
          limiteAlcanzado: true,
          mensaje: 'Alcanzaste tu límite mensual de IA para tu plan. Mejora tu plan para seguir usando SORY.',
        });
      }
    }
    next();
  } catch (err) {
    console.error('[verificarLimiteIA] error:', err);
    next(); // si falla el conteo, no bloqueamos al usuario por un problema nuestro
  }
}

// Convierte una fila de convocatoria (requisitos/documentos guardados como texto JSON) a objeto listo para el frontend.
function parseConvocatoria(r) {
  return {
    ...r,
    requisitos: JSON.parse(r.requisitos || '[]'),
    documentos: JSON.parse(r.documentos || '[]'),
  };
}

// =====================================================================
// Salud del servicio
// =====================================================================
app.get('/api/health', (req, res) => {
  res.json({ ok: true, servicio: 'Fondos Sin Fronteras AI API', hora: new Date().toISOString() });
});

// =====================================================================
// SORY — chat real con Claude (no toca la base de datos)
// =====================================================================
app.post('/api/sory/chat', requireAuth, verificarLimiteIA, async (req, res) => {
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
      max_tokens: 1536,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: 'Eres SORY, la asistente de inteligencia artificial de Fondos Sin Fronteras AI. Ayudas a organizaciones sociales a formular proyectos y acceder a cooperación internacional. Respondes en español, de forma clara, honesta y práctica. Tienes acceso a búsqueda web: úsala cuando la pregunta necesite información actual, específica de un país, cifras recientes, normativas vigentes, organismos concretos o convocatorias puntuales — cita la fuente cuando la uses. Para preguntas conceptuales generales (qué es un marco lógico, cómo estructurar un presupuesto, etc.) puedes responder directamente desde tu conocimiento sin necesidad de buscar. Si no tienes información verificada sobre algo, lo dices explícitamente en vez de inventar datos.',
      messages,
    });

    const texto = extraerTexto(respuesta);
    await incrementarUsoIA(req.user.org).catch((e) => console.error('[incrementarUsoIA sory] ', e));
    res.status(200).json({ respuesta: texto });
  } catch (err) {
    console.error('[sory/chat] error:', err);
    res.status(500).json({ error: err.message || 'Error al consultar a SORY.' });
  }
});

// =====================================================================
// Búsqueda de convocatorias en tiempo real con IA + búsqueda web (no toca la base de datos)
// =====================================================================
app.post('/api/convocatorias/buscar-ia', requireAuth, verificarLimiteIA, async (req, res) => {
  const { consulta } = req.body || {};
  if (!consulta || typeof consulta !== 'string' || !consulta.trim()) {
    return res.status(400).json({ error: 'Falta el campo "consulta" (texto) en el cuerpo de la solicitud.' });
  }
  try {
    const anthropic = getClient();

    const respuesta = await anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: [
        'Eres un buscador de convocatorias, fondos y becas de cooperación internacional VIGENTES.',
        'Busca en la web información real y actual, priorizando fuentes oficiales: organismos cooperantes,',
        'Naciones Unidas, Unión Europea, BID, USAID, fundaciones privadas y gobiernos.',
        'Responde ÚNICAMENTE con un JSON válido, sin texto adicional antes o después, exactamente con esta forma:',
        '{ "resultados": [ { "nombre": "...", "cooperante": "...", "pais": "...", "sector": "...",',
        '"monto": "...", "fecha_cierre": "...", "resumen": "...", "url": "..." } ] }',
        'Máximo 6 resultados. Si no encuentras nada relevante o vigente, responde { "resultados": [] }.',
        'Sé conciso en el campo "resumen" (máximo 2 frases) para no arriesgar cortar la respuesta.',
      ].join(' '),
      messages: [{ role: 'user', content: consulta }],
    });

    const texto = extraerTexto(respuesta);
    const payload = repararJSON(texto);

    if (!payload || !Array.isArray(payload.resultados)) {
      throw new Error('El JSON devuelto no tiene la forma esperada ({ "resultados": [...] }).');
    }

    await incrementarUsoIA(req.user.org).catch((e) => console.error('[incrementarUsoIA buscar-ia] ', e));
    res.status(200).json(payload);
  } catch (err) {
    console.error('[convocatorias/buscar-ia] error:', err);
    // Si el error viene directo de la API de Anthropic por límite de uso/gasto alcanzado,
    // devolvemos un mensaje claro en vez del texto crudo del error (que confunde con un
    // problema de JSON cuando en realidad es un límite temporal de la cuenta).
    if (err && err.error && err.error.type === 'rate_limit_error') {
      return res.status(429).json({
        error: 'La cuenta de IA alcanzó su límite de uso mensual. Vuelve a intentar más tarde o contacta al administrador de la plataforma para ampliar el límite.',
      });
    }
    res.status(500).json({ error: err.message || 'Error al buscar convocatorias con IA.' });
  }
});

// =====================================================================
// Guardar una convocatoria encontrada por IA en la base de datos compartida.
// Queda visible para TODOS los usuarios, marcada como "pendiente_revision"
// hasta que la administradora la revise y confirme.
// =====================================================================
app.post('/api/convocatorias/guardar-desde-ia', requireAuth, async (req, res) => {
  const { nombre, cooperante, pais, sector, monto, fecha_cierre, resumen, url } = req.body || {};
  if (!nombre || !cooperante) {
    return res.status(400).json({ error: 'Faltan datos mínimos (nombre y cooperante) para guardar la convocatoria.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO convocatorias
        (nombre, cooperante, pais, sector, monto, fecha_inicio, fecha_cierre, descripcion, requisitos, documentos, tdr, url, estado_verificacion)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,'[]','[]',NULL,$8,'pendiente_revision')
       RETURNING id`,
      [nombre, cooperante, pais || null, sector || null, monto || null, fecha_cierre || null, resumen || null, url || null]
    );
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('[convocatorias/guardar-desde-ia] error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar la convocatoria encontrada por IA.' });
  }
});
// =====================================================================
// CRM de donantes y aliados (real, ligado a la organización)
// =====================================================================
const ETAPAS_CRM = ['prospecto', 'en_conversacion', 'aliado_activo', 'convenio_firmado'];

app.get('/api/crm/contactos', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM contactos_crm WHERE organizacion_id = $1 ORDER BY actualizado_en DESC',
      [req.user.org]
    );
    res.json(rows);
  } catch (err) {
    console.error('[crm/contactos GET] error:', err);
    res.status(500).json({ error: err.message || 'Error al listar contactos del CRM.' });
  }
});

app.post('/api/crm/contactos', requireAuth, async (req, res) => {
  const { nombre, tipo, etapa, nota } = req.body || {};
  if (!nombre || !nombre.trim()) {
    return res.status(400).json({ error: 'El contacto necesita un nombre.' });
  }
  const etapaFinal = ETAPAS_CRM.includes(etapa) ? etapa : 'prospecto';
  try {
  const { rows } = await pool.query(
      `INSERT INTO contactos_crm (organizacion_id, nombre, tipo, etapa, nota, proximo_seguimiento)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.org, nombre.trim(), tipo || null, etapaFinal, nota || null, req.body.proximo_seguimiento || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[crm/contactos POST] error:', err);
    res.status(500).json({ error: err.message || 'Error al crear el contacto.' });
  }
});

app.patch('/api/crm/contactos/:id', requireAuth, async (req, res) => {
  try {
    const { rows: existentes } = await pool.query(
      'SELECT id FROM contactos_crm WHERE id = $1 AND organizacion_id = $2',
      [req.params.id, req.user.org]
    );
    if (!existentes[0]) return res.status(404).json({ error: 'Contacto no encontrado.' });

    const campos = ['nombre', 'tipo', 'etapa', 'nota', 'proximo_seguimiento'];
    const sets = [];
    const vals = [];
    let i = 1;
    for (const c of campos) {
      if (req.body[c] !== undefined) {
        if (c === 'etapa' && !ETAPAS_CRM.includes(req.body.etapa)) continue;
        sets.push(`${c} = $${i++}`);
        vals.push(req.body[c]);
      }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nada que actualizar.' });
    sets.push('actualizado_en = now()');
    vals.push(req.params.id);
    await pool.query(`UPDATE contactos_crm SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    res.json({ ok: true });
  } catch (err) {
    console.error('[crm/contactos PATCH] error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar el contacto.' });
  }
});

app.delete('/api/crm/contactos/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM contactos_crm WHERE id = $1 AND organizacion_id = $2',
      [req.params.id, req.user.org]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[crm/contactos DELETE] error:', err);
    res.status(500).json({ error: err.message || 'Error al eliminar el contacto.' });
  }
});
// =====================================================================
// Panel de administradora de la plataforma (solo SUPERADMIN_EMAILS)
// =====================================================================
app.get('/api/admin/convocatorias-pendientes', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM convocatorias WHERE estado_verificacion = 'pendiente_revision' ORDER BY creado_en DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error('[admin/convocatorias-pendientes] error:', err);
    res.status(500).json({ error: err.message || 'Error al listar convocatorias pendientes.' });
  }
});

app.post('/api/admin/convocatorias/:id/aprobar', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await pool.query("UPDATE convocatorias SET estado_verificacion = 'verificada' WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/convocatorias/:id/aprobar] error:', err);
    res.status(500).json({ error: err.message || 'Error al aprobar la convocatoria.' });
  }
});

app.delete('/api/admin/convocatorias/:id', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM convocatorias WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('[admin/convocatorias/:id DELETE] error:', err);
    res.status(500).json({ error: err.message || 'Error al eliminar la convocatoria.' });
  }
});

app.post('/api/admin/convocatorias', requireAuth, requireSuperAdmin, async (req, res) => {
  const { nombre, cooperante, pais, sector, monto, fecha_inicio, fecha_cierre, descripcion, requisitos, documentos, tdr, url } = req.body || {};
  if (!nombre || !cooperante) {
    return res.status(400).json({ error: 'Faltan datos mínimos (nombre y cooperante).' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO convocatorias
        (nombre, cooperante, pais, sector, monto, fecha_inicio, fecha_cierre, descripcion, requisitos, documentos, tdr, url, estado_verificacion)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'verificada')
       RETURNING id`,
      [
        nombre, cooperante, pais || null, sector || null, monto || null,
        fecha_inicio || null, fecha_cierre || null, descripcion || null,
        JSON.stringify(requisitos ? requisitos.split('\n').filter(Boolean) : []),
        JSON.stringify(documentos ? documentos.split('\n').filter(Boolean) : []),
        tdr || null, url || null,
      ]
    );
    res.status(201).json({ ok: true, id: rows[0].id });
  } catch (err) {
    console.error('[admin/convocatorias POST] error:', err);
    res.status(500).json({ error: err.message || 'Error al crear la convocatoria.' });
  }
});

// =====================================================================
// Autenticación
// =====================================================================
app.post('/api/auth/registro', async (req, res) => {
  const { nombreOrganizacion, pais, sector, nombreUsuario, email, password } = req.body || {};
  if (!nombreOrganizacion || !email || !password || password.length < 8) {
    return res.status(400).json({ error: 'Faltan campos requeridos o la contraseña tiene menos de 8 caracteres.' });
  }
  try {
    const existente = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (existente.rows.length > 0) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
    }

    const orgResult = await pool.query(
      'INSERT INTO organizaciones (nombre, pais, sector) VALUES ($1, $2, $3) RETURNING id',
      [nombreOrganizacion, pais || 'Colombia', sector || null]
    );
    const orgId = orgResult.rows[0].id;

    const hash = bcrypt.hashSync(password, 10);
    const userResult = await pool.query(
      `INSERT INTO usuarios (organizacion_id, nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, $4, 'administrador') RETURNING id`,
      [orgId, nombreUsuario || 'Administrador', email, hash]
    );
    const userId = userResult.rows[0].id;

    const usuario = { id: userId, organizacion_id: orgId, rol: 'administrador', email };
    const token = signToken(usuario);
    res.status(201).json({ token, organizacionId: orgId, usuarioId: userId });
  } catch (err) {
    console.error('[auth/registro] error:', err);
    res.status(500).json({ error: err.message || 'Error al registrar la organización.' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  try {
    const { rows } = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    const usuario = rows[0];
    if (!usuario || !bcrypt.compareSync(password || '', usuario.password_hash)) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }
    const token = signToken(usuario);
    res.json({ token, organizacionId: usuario.organizacion_id, usuarioId: usuario.id });
  } catch (err) {
    console.error('[auth/login] error:', err);
    res.status(500).json({ error: err.message || 'Error al iniciar sesión.' });
  }
});

// =====================================================================
// Organización / perfil propio
// =====================================================================
app.get('/api/organizaciones/me', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM organizaciones WHERE id = $1', [req.user.org]);
    if (!rows[0]) return res.status(404).json({ error: 'Organización no encontrada.' });
    const org = rows[0];
    const limite = LIMITES_PLAN_IA[org.plan]; // undefined = ilimitado
    const usoIaActual = await obtenerUsoIA(org.id).catch(() => 0);
    res.json({ ...org, usoIaActual, usoIaLimite: limite === undefined ? null : limite });
  } catch (err) {
    console.error('[organizaciones/me] error:', err);
    res.status(500).json({ error: err.message || 'Error al obtener la organización.' });
  }
});

// =====================================================================
// Convocatorias
// =====================================================================
app.get('/api/convocatorias', async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM convocatorias WHERE estado_verificacion != 'retirada' ORDER BY fecha_cierre ASC"
    );
    res.json(rows.map(parseConvocatoria));
  } catch (err) {
    console.error('[convocatorias] error:', err);
    console.error('[convocatorias] error:', err);
    res.status(500).json({ error: err.message || 'Error al listar convocatorias.' });
  }
});

app.get('/api/convocatorias/:id', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM convocatorias WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Convocatoria no encontrada.' });
    res.json(parseConvocatoria(rows[0]));
  } catch (err) {
    console.error('[convocatorias/:id] error:', err);
    res.status(500).json({ error: err.message || 'Error al obtener la convocatoria.' });
  }
});

app.post('/api/convocatorias/:id/reportes', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id FROM convocatorias WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Convocatoria no encontrada.' });
    await pool.query("UPDATE convocatorias SET estado_verificacion = 'en_revision' WHERE id = $1", [req.params.id]);
    res.json({ ok: true, mensaje: 'Reporte recibido. La convocatoria queda en revisión.' });
  } catch (err) {
    console.error('[convocatorias/:id/reportes] error:', err);
    res.status(500).json({ error: err.message || 'Error al registrar el reporte.' });
  }
});

// ---- Favoritas ----
app.post('/api/convocatorias/:id/favorito', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'INSERT INTO favoritos (usuario_id, convocatoria_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [req.user.sub, req.params.id]
    );
    res.json({ ok: true, favorito: true });
  } catch (err) {
    console.error('[favorito POST] error:', err);
    res.status(500).json({ error: err.message || 'Error al marcar como favorita.' });
  }
});
app.delete('/api/convocatorias/:id/favorito', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM favoritos WHERE usuario_id = $1 AND convocatoria_id = $2', [req.user.sub, req.params.id]);
    res.json({ ok: true, favorito: false });
  } catch (err) {
    console.error('[favorito DELETE] error:', err);
    res.status(500).json({ error: err.message || 'Error al quitar de favoritas.' });
  }
});
app.get('/api/favoritos', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.* FROM favoritos f JOIN convocatorias c ON c.id = f.convocatoria_id WHERE f.usuario_id = $1`,
      [req.user.sub]
    );
    res.json(rows.map(parseConvocatoria));
  } catch (err) {
    console.error('[favoritos] error:', err);
    res.status(500).json({ error: err.message || 'Error al listar favoritas.' });
  }
});

// =====================================================================
// Proyectos (Constructor Inteligente)
// =====================================================================
app.post('/api/proyectos', requireAuth, async (req, res) => {
  const { titulo, convocatoriaId, diagnostico, objetivoGeneral, objetivosEspecificos, resultados, presupuesto, cronograma } = req.body || {};
  if (!titulo) return res.status(400).json({ error: 'El proyecto necesita un título.' });
  try {
    const { rows } = await pool.query(
      `INSERT INTO proyectos
        (organizacion_id, convocatoria_id, titulo, diagnostico, objetivo_general, objetivos_especificos, resultados, presupuesto, cronograma)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        req.user.org, convocatoriaId || null, titulo, diagnostico || '', objetivoGeneral || '',
        JSON.stringify(objetivosEspecificos || []), JSON.stringify(resultados || []),
        JSON.stringify(presupuesto || []), JSON.stringify(cronograma || []),
      ]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error('[proyectos POST] error:', err);
    res.status(500).json({ error: err.message || 'Error al crear el proyecto.' });
  }
});

app.get('/api/proyectos', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM proyectos WHERE organizacion_id = $1 ORDER BY actualizado_en DESC',
      [req.user.org]
    );
    res.json(rows);
  } catch (err) {
    console.error('[proyectos GET] error:', err);
    res.status(500).json({ error: err.message || 'Error al listar proyectos.' });
  }
});

app.patch('/api/proyectos/:id', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM proyectos WHERE id = $1 AND organizacion_id = $2',
      [req.params.id, req.user.org]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    const camposSimples = ['titulo', 'diagnostico', 'objetivo_general', 'estado'];
    const camposJson = ['objetivos_especificos', 'resultados', 'presupuesto', 'cronograma'];
    const sets = [];
    const vals = [];
    let i = 1;

    for (const c of camposSimples) {
      if (req.body[c] !== undefined) { sets.push(`${c} = $${i++}`); vals.push(req.body[c]); }
    }
    for (const c of camposJson) {
      if (req.body[c] !== undefined) { sets.push(`${c} = $${i++}`); vals.push(JSON.stringify(req.body[c])); }
    }
    sets.push(`actualizado_en = now()`);
    vals.push(req.params.id);

    await pool.query(`UPDATE proyectos SET ${sets.join(', ')} WHERE id = $${i}`, vals);
    res.json({ ok: true });
  } catch (err) {
    console.error('[proyectos PATCH] error:', err);
    res.status(500).json({ error: err.message || 'Error al actualizar el proyecto.' });
  }
});

app.get('/api/proyectos/:id/pdf', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM proyectos WHERE id = $1 AND organizacion_id = $2',
      [req.params.id, req.user.org]
    );
    const proyecto = rows[0];
    if (!proyecto) return res.status(404).json({ error: 'Proyecto no encontrado.' });

    const { rows: orgRows } = await pool.query('SELECT * FROM organizaciones WHERE id = $1', [req.user.org]);
    const org = orgRows[0];

    let convocatoriaNombre = null;
    if (proyecto.convocatoria_id) {
      const { rows: convRows } = await pool.query('SELECT nombre FROM convocatorias WHERE id = $1', [proyecto.convocatoria_id]);
      convocatoriaNombre = convRows[0] ? convRows[0].nombre : null;
    }

    streamProjectPDF(res, { ...proyecto, convocatoria_nombre: convocatoriaNombre }, org);
  } catch (err) {
    console.error('[proyectos/:id/pdf] error:', err);
    res.status(500).json({ error: err.message || 'Error al generar el PDF.' });
  }
});

// =====================================================================
// Notificaciones
// =====================================================================
app.get('/api/notificaciones', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM notificaciones WHERE organizacion_id = $1 ORDER BY creado_en DESC LIMIT 30',
      [req.user.org]
    );
    res.json(rows);
  } catch (err) {
    console.error('[notificaciones] error:', err);
    res.status(500).json({ error: err.message || 'Error al listar notificaciones.' });
  }
});
app.post('/api/notificaciones/:id/leida', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notificaciones SET leida = 1 WHERE id = $1 AND organizacion_id = $2',
      [req.params.id, req.user.org]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[notificaciones/:id/leida] error:', err);
    res.status(500).json({ error: err.message || 'Error al marcar como leída.' });
  }
});

// =====================================================================
// Suscripción y pagos
// =====================================================================
app.get('/api/suscripcion', requireAuth, async (req, res) => {
  try {
    await checkExpirations();
    const { rows } = await pool.query(
      'SELECT plan, estado_suscripcion, suscripcion_inicio, suscripcion_fin FROM organizaciones WHERE id = $1',
      [req.user.org]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[suscripcion] error:', err);
    res.status(500).json({ error: err.message || 'Error al obtener la suscripción.' });
  }
});

app.get('/api/transacciones', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM transacciones WHERE organizacion_id = $1 ORDER BY creado_en DESC LIMIT 30',
      [req.user.org]
    );
    res.json(rows);
  } catch (err) {
    console.error('[transacciones] error:', err);
    res.status(500).json({ error: err.message || 'Error al listar transacciones.' });
  }
});

app.post('/api/pagos/iniciar', requireAuth, async (req, res) => {
  const { plan, metodo } = req.body || {};
  if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Plan inválido.' });
  if (!['paypal', 'nequi', 'pse', 'transferencia'].includes(metodo)) {
    return res.status(400).json({ error: 'Método de pago inválido.' });
  }
  try {
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
  } catch (err) {
    console.error('[pagos/iniciar] error:', err);
    res.status(500).json({ error: err.message || 'Error al iniciar el pago.' });
  }
});

app.post('/api/pagos/webhook/paypal', express.json({ type: '*/*' }), (req, res) => {
  const evento = req.body;
  console.log('[webhook paypal] evento recibido:', JSON.stringify(evento).slice(0, 300));
  res.status(200).json({ recibido: true });
});

app.post('/api/pagos/confirmar', requireAuth, async (req, res) => {
  const { plan } = req.body || {};
  if (!PLAN_PRICES[plan]) return res.status(400).json({ error: 'Plan inválido.' });
  try {
    const resultado = await activateOrganization(req.user.org, plan);
    await pool.query(
      `UPDATE transacciones SET estado = 'confirmada' WHERE organizacion_id = $1 AND plan = $2 AND estado = 'pendiente'`,
      [req.user.org, plan]
    );
    res.json(resultado);
  } catch (err) {
    console.error('[pagos/confirmar] error:', err);
    res.status(500).json({ error: err.message || 'Error al confirmar el pago.' });
  }
});

// =====================================================================
// Arranque: primero crea/verifica las tablas en PostgreSQL, luego levanta el servidor
// =====================================================================
const PORT = process.env.PORT || 4000;

initDb()
  .then(() => {
    checkExpirations();
    setInterval(checkExpirations, 60 * 1000);

    app.listen(PORT, () => {
      console.log(`Fondos Sin Fronteras AI API escuchando en http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('No se pudo inicializar la base de datos PostgreSQL:', err);
    process.exit(1);
  });

module.exports = app;
