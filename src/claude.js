// claude.js — Cliente de Anthropic compartido por /api/sory/chat y /api/convocatorias/buscar-ia
const Anthropic = require('@anthropic-ai/sdk');

// ⚠️ "claude-sonnet-4-6" (mencionado en la solicitud original) no corresponde a ningún
// modelo vigente que se pueda confirmar en la documentación pública al momento de escribir
// esto. Se deja configurable por variable de entorno para no arriesgar un nombre incorrecto.
// Si tienes el nombre exacto confirmado en tu cuenta de Anthropic, ponlo en ANTHROPIC_MODEL
// en Render — si no defines nada, usa este valor por defecto.
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

let cliente = null;

/**
 * Devuelve un cliente de Anthropic ya configurado, o lanza un error claro
 * si falta la variable de entorno ANTHROPIC_API_KEY.
 */
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Falta configurar la variable de entorno ANTHROPIC_API_KEY en el servidor.');
  }
  if (!cliente) {
    cliente = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return cliente;
}

/** Extrae el primer bloque de texto de una respuesta de la API de Anthropic. */
function extraerTexto(respuesta) {
  const bloque = respuesta.content.find((b) => b.type === 'text');
  if (!bloque || !bloque.text) {
    throw new Error('La IA no devolvió una respuesta de texto.');
  }
  return bloque.text;
}

/** Convierte el texto de respuesta en JSON, quitando los backticks ```json si vienen. */
function parsearJSON(texto) {
  const limpio = texto.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(limpio);
  } catch (err) {
    throw new Error('La IA no devolvió un JSON válido: ' + err.message);
  }
}

module.exports = { getClient, extraerTexto, parsearJSON, ANTHROPIC_MODEL };
