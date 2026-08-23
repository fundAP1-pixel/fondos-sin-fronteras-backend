// db.js — Base de datos real en PostgreSQL (Neon / Render Postgres)
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }, // necesario para Neon y Render Postgres
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS organizaciones (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      pais TEXT NOT NULL,
      sector TEXT,
      plan TEXT NOT NULL DEFAULT 'GRATIS',
      estado_suscripcion TEXT NOT NULL DEFAULT 'sin_plan',
      suscripcion_inicio TEXT,
      suscripcion_fin TEXT,
      nivel_madurez INTEGER NOT NULL DEFAULT 0,
      creado_en TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      organizacion_id INTEGER NOT NULL REFERENCES organizaciones(id),
      nombre TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      rol TEXT NOT NULL DEFAULT 'administrador',
      creado_en TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS convocatorias (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      cooperante TEXT NOT NULL,
      pais TEXT,
      sector TEXT,
      monto TEXT,
      fecha_inicio TEXT,
      fecha_cierre TEXT,
      descripcion TEXT,
      requisitos TEXT,
      documentos TEXT,
      tdr TEXT,
      url TEXT,
      estado_verificacion TEXT NOT NULL DEFAULT 'verificada',
      creado_en TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS favoritos (
      usuario_id INTEGER NOT NULL REFERENCES usuarios(id),
      convocatoria_id INTEGER NOT NULL REFERENCES convocatorias(id),
      creado_en TIMESTAMP NOT NULL DEFAULT now(),
      PRIMARY KEY (usuario_id, convocatoria_id)
    );

    C
