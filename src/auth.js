// auth.js — Autenticación real con JWT (HS256) y hash de contraseñas con bcrypt
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

// IMPORTANTE: ya no existe una clave de respaldo insegura. Si la variable de entorno
// JWT_SECRET no está configurada en el servidor (Render), el sistema se detiene al
// arrancar en vez de usar una clave conocida públicamente en el código fuente.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error(
    'JWT_SECRET no está configurada (o es demasiado corta). Configura una variable de entorno ' +
    'JWT_SECRET con un valor largo y aleatorio (mínimo 32 caracteres) en Render antes de arrancar el servidor.'
  );
}
const JWT_EXPIRES_IN = '2h';

function signToken(usuario) {
  return jwt.sign(
    { sub: usuario.id, org: usuario.organizacion_id, rol: usuario.rol, email: usuario.email },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Falta el token de autenticación (Authorization: Bearer ...)' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Revisamos en la base de datos, en cada solicitud, si la cuenta fue suspendida
    // después de emitirse el token — así una suspensión aplica de inmediato, no hasta
    // que el token expire por sí solo (hasta 2 horas después).
    const { rows } = await pool.query('SELECT suspendido FROM usuarios WHERE id = $1', [payload.sub]);
    if (!rows[0]) return res.status(401).json({ error: 'La cuenta ya no existe.' });
    if (rows[0].suspendido) {
      return res.status(403).json({ error: 'Tu cuenta ha sido suspendida. Contacta al administrador de la plataforma.' });
    }
    req.user = payload; // { sub, org, rol, email }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

module.exports = { signToken, requireAuth, JWT_SECRET };
