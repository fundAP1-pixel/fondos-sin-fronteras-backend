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

    CREATE TABLE IF NOT EXISTS proyectos (
      id SERIAL PRIMARY KEY,
      organizacion_id INTEGER NOT NULL REFERENCES organizaciones(id),
      convocatoria_id INTEGER REFERENCES convocatorias(id),
      titulo TEXT NOT NULL,
      diagnostico TEXT,
      objetivo_general TEXT,
      objetivos_especificos TEXT,
      resultados TEXT,
      presupuesto TEXT,
      cronograma TEXT,
      estado TEXT NOT NULL DEFAULT 'borrador',
      creado_en TIMESTAMP NOT NULL DEFAULT now(),
      actualizado_en TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS notificaciones (
      id SERIAL PRIMARY KEY,
      organizacion_id INTEGER NOT NULL REFERENCES organizaciones(id),
      tipo TEXT NOT NULL,
      texto TEXT NOT NULL,
      leida INTEGER NOT NULL DEFAULT 0,
      creado_en TIMESTAMP NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS transacciones (
      id SERIAL PRIMARY KEY,
      organizacion_id INTEGER NOT NULL REFERENCES organizaciones(id),
      plan TEXT NOT NULL,
      monto TEXT NOT NULL,
      metodo TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      referencia_externa TEXT,
      creado_en TIMESTAMP NOT NULL DEFAULT now()
    );

   CREATE TABLE IF NOT EXISTS uso_ia (
      organizacion_id INTEGER NOT NULL REFERENCES organizaciones(id),
      mes TEXT NOT NULL,
      contador INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (organizacion_id, mes)
    );

    CREATE TABLE IF NOT EXISTS contactos_crm (
      id SERIAL PRIMARY KEY,
      organizacion_id INTEGER NOT NULL REFERENCES organizaciones(id),
      nombre TEXT NOT NULL,
      tipo TEXT,
      etapa TEXT NOT NULL DEFAULT 'prospecto',
      nota TEXT,
      proximo_seguimiento DATE,
      creado_en TIMESTAMP NOT NULL DEFAULT now(),
      actualizado_en TIMESTAMP NOT NULL DEFAULT now()
    );

    ALTER TABLE contactos_crm ADD COLUMN IF NOT EXISTS proximo_seguimiento DATE;
  `);

  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM convocatorias');
  if (rows[0].n === 0) {
    const seed = [
      ['Fondo Verde Climático — Adaptación rural', 'Unión Europea', 'Colombia', 'Medioambiente', '€120.000', '2026-08-01', '2026-08-17',
        'Financia proyectos que fortalezcan la capacidad de adaptación al cambio climático en comunidades rurales.',
        JSON.stringify(['Personería jurídica vigente (mínimo 2 años)', 'Experiencia previa en proyectos ambientales', 'Cofinanciación mínima del 10%']),
        JSON.stringify(['Certificado de existencia y representación legal', 'Estados financieros 2 años', 'Carta de cofinanciación']),
        'Enfoque de adaptación basada en ecosistemas, articulación con autoridades locales, sostenibilidad a 24 meses.',
        'https://www.eeas.europa.eu/delegations/colombia_es'],
      ['USAID — Fortalecimiento comunitario', 'USAID', 'Guatemala', 'Gobernanza', 'US$95.000', '2026-07-15', '2026-08-26',
        'Apoya iniciativas de participación ciudadana y gobernanza local.',
        JSON.stringify(['Organización local o consorcio con socio local', 'Mínimo 3 años de operación']),
        JSON.stringify(['Registro legal actualizado', 'Manual de procedimientos financieros']),
        'Modelo lógico con indicadores SMART y línea de base verificable.',
        'https://www.usaid.gov/guatemala'],
      ['BID Lab — Innovación social', 'BID', 'Perú', 'Innovación', 'US$60.000', '2026-06-20', '2026-08-13',
        'Financia soluciones innovadoras con impacto social medible.',
        JSON.stringify(['Prototipo ya validado', 'Modelo de sostenibilidad financiera']),
        JSON.stringify(['Descripción técnica del prototipo', 'Plan de escalamiento']),
        'Prioriza soluciones escalables a más de un país de la región.',
        'https://bidlab.org/es/convocatorias'],
      ['Fundación Ford — Justicia de género', 'Privada', 'México', 'Género', 'US$80.000', '2026-07-01', '2026-09-04',
        'Apoya organizaciones que trabajan por la justicia de género y el empoderamiento económico de mujeres.',
        JSON.stringify(['Trayectoria comprobada en temas de género', 'Enfoque interseccional documentado', 'Alianzas con organizaciones de base']),
        JSON.stringify(['Informe narrativo de proyectos anteriores', 'Política interna de género']),
        'Solicita análisis interseccional explícito y participación directa de las beneficiarias. No financia infraestructura física.',
        'https://www.fordfoundation.org/work/our-grants/'],
      ['ACNUR — Protección y desplazamiento', 'Naciones Unidas', 'Ecuador', 'Protección', 'US$110.000', '2026-07-10', '2026-08-23',
        'Financia respuestas de protección a población en situación de desplazamiento forzado y refugio.',
        JSON.stringify(['Experiencia en protección humanitaria', 'Protocolos de protección de datos']),
        JSON.stringify(['Protocolo de protección y confidencialidad', 'Registro ante autoridad migratoria']),
        'Exige cumplimiento estricto de principios humanitarios y mecanismo de quejas accesible para beneficiarios.',
        'https://www.acnur.org/convocatorias'],
      ['Unión Europea — Gobernanza local', 'Unión Europea', 'Bolivia', 'Gobernanza', '€150.000', '2026-07-05', '2026-09-14',
        'Fortalece capacidades institucionales de gobiernos locales para la planificación participativa.',
        JSON.stringify(['Convenio o carta de respaldo del gobierno local', 'Experiencia en fortalecimiento institucional']),
        JSON.stringify(['Convenio de cooperación con la entidad pública', 'Diagnóstico institucional previo']),
        'Exige que al menos 30% del presupuesto se destine a fortalecimiento de capacidades, no a infraestructura.',
        'https://www.eeas.europa.eu/delegations/bolivia_es'],
    ];
    for (const row of seed) {
      await pool.query(
        `INSERT INTO convocatorias
          (nombre, cooperante, pais, sector, monto, fecha_inicio, fecha_cierre, descripcion, requisitos, documentos, tdr, url, estado_verificacion)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'verificada')`,
        row
      );
    }
  }
}

module.exports = { pool, bcrypt, initDb, obtenerUsoIA, incrementarUsoIA };

/**
 * Devuelve cuántas veces ha usado la IA (SORY + buscador) una organización en el mes en curso.
 */
async function obtenerUsoIA(orgId) {
  const mes = new Date().toISOString().slice(0, 7); // 'YYYY-MM'
  const { rows } = await pool.query(
    'SELECT contador FROM uso_ia WHERE organizacion_id = $1 AND mes = $2',
    [orgId, mes]
  );
  return rows[0] ? rows[0].contador : 0;
}

/**
 * Suma 1 al contador de uso de IA del mes en curso para una organización.
 * Crea la fila si no existe (INSERT ... ON CONFLICT).
 */
async function incrementarUsoIA(orgId) {
  const mes = new Date().toISOString().slice(0, 7);
  await pool.query(
    `INSERT INTO uso_ia (organizacion_id, mes, contador) VALUES ($1, $2, 1)
     ON CONFLICT (organizacion_id, mes) DO UPDATE SET contador = uso_ia.contador + 1`,
    [orgId, mes]
  );
}
