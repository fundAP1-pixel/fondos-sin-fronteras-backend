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

/**
 * Extrae el texto final de una respuesta de la API de Anthropic.
 *
 * Cuando la respuesta usa la herramienta de búsqueda web (web_search_20250305),
 * Anthropic puede devolver VARIOS bloques de tipo "text" en el mismo mensaje:
 * un texto inicial/comentario antes o durante la búsqueda, y el texto final
 * con la respuesta ya sintetizada después de buscar. Tomar el PRIMER bloque
 * (como se hacía antes) agarra ese comentario intermedio en vez del JSON final,
 * lo que producía errores como "Unexpected token 'I', "I have eno"...".
 *
 * Por eso aquí se toma el ÚLTIMO bloque de texto, que es el que contiene la
 * respuesta definitiva del modelo tras completar la búsqueda.
 */
function extraerTexto(respuesta) {
  const bloques = respuesta.content.filter((b) => b.type === 'text' && b.text);
  if (bloques.length === 0) {
    throw new Error('La IA no devolvió una respuesta de texto.');
  }
  return bloques[bloques.length - 1].text;
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

/**
 * Igual que parsearJSON, pero si el texto viene cortado a la mitad (respuesta truncada),
 * intenta "cerrar" el JSON en el último objeto completo antes de rendirse.
 * Así una búsqueda con 5 resultados completos y un 6º cortado no pierde los 5 buenos.
 */
function repararJSON(texto) {
  const limpio = texto.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(limpio);
  } catch (err) {
    // Intento 1: quedarnos solo con lo que hay entre la primera "{" y la última "}",
    // por si quedó texto de comentario pegado antes o después del JSON real.
    const inicio = limpio.indexOf('{');
    const fin = limpio.lastIndexOf('}');
    if (inicio !== -1 && fin !== -1 && fin > inicio) {
      const soloJSON = limpio.slice(inicio, fin + 1);
      try { return JSON.parse(soloJSON); } catch (e1) { /* sigue al intento 2 */ }

      // Intento 2: dentro de ese recorte, cortar justo después del último objeto completo "},"
      const idx1 = soloJSON.lastIndexOf('},');
      if (idx1 !== -1) {
        const intento = soloJSON.slice(0, idx1 + 1) + ']}';
        try { return JSON.parse(intento); } catch (e2) { /* sigue al intento 3 */ }
      }
      // Intento 3: cortar en el último "}" que haya, por si solo hay un objeto
      const idx2 = soloJSON.lastIndexOf('}');
      if (idx2 !== -1) {
        const intento2 = soloJSON.slice(0, idx2 + 1) + ']}';
        try { return JSON.parse(intento2); } catch (e3) { /* sigue al error final */ }
      }
    }
    throw new Error('La IA no devolvió un JSON válido ni siquiera recuperable parcialmente: ' + err.message);
  }
}

module.exports = { getClient, extraerTexto, parsearJSON, repararJSON, ANTHROPIC_MODEL };
