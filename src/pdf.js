// pdf.js — Genera el PDF real de un proyecto (streaming directo a la respuesta HTTP)
const PDFDocument = require('pdfkit');

const AZUL = '#1B3A6B';
const DORADO = '#C9A23A';
const GRIS = '#8C8C8C';

function streamProjectPDF(res, proyecto, organizacion) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${proyecto.titulo.replace(/[^a-z0-9]+/gi, '_')}.pdf"`);
  doc.pipe(res);

  // Encabezado
  doc.rect(0, 0, doc.page.width, 80).fill(AZUL);
  doc.fillColor('#FFFFFF').fontSize(18).font('Helvetica-Bold').text(proyecto.titulo, 50, 24, { width: doc.page.width - 100 });
  doc.fontSize(10).font('Helvetica').fillColor('#C9D6EA')
    .text(`${organizacion.nombre}  ·  ${proyecto.convocatoria_nombre || 'Sin convocatoria asociada'}`, 50, 52);
  doc.fontSize(8).fillColor(DORADO).text('FONDOS SIN FRONTERAS AI — Generado con SORY', 50, 66);

  doc.moveDown(4);
  doc.fillColor('#000000');

  function section(title) {
    doc.moveDown(0.6);
    doc.fontSize(13).font('Helvetica-Bold').fillColor(AZUL).text(title);
    doc.moveTo(doc.x, doc.y + 2).lineTo(doc.x + 40, doc.y + 2).strokeColor(DORADO).lineWidth(1.5).stroke();
    doc.moveDown(0.6);
    doc.font('Helvetica').fontSize(10.5).fillColor('#222222');
  }

  section('Diagnóstico');
  doc.text(proyecto.diagnostico || 'No definido.');

  section('Objetivo general');
  doc.text(proyecto.objetivo_general || 'No definido.');

  const objetivos = JSON.parse(proyecto.objetivos_especificos || '[]');
  if (objetivos.length) {
    section('Objetivos específicos');
    objetivos.forEach(o => doc.text(`•  ${o}`));
  }

  const resultados = JSON.parse(proyecto.resultados || '[]');
  if (resultados.length) {
    section('Resultados esperados');
    resultados.forEach(r => doc.text(`•  ${r}`));
  }

  const presupuesto = JSON.parse(proyecto.presupuesto || '[]');
  if (presupuesto.length) {
    section('Presupuesto');
    presupuesto.forEach(([linea, valor]) => {
      const y = doc.y;
      doc.text(linea, 50, y, { continued: false, width: 350 });
      doc.font('Helvetica-Bold').text(String(valor), 400, y, { width: 145, align: 'right' });
      doc.font('Helvetica');
    });
  }

  const cronograma = JSON.parse(proyecto.cronograma || '[]');
  if (cronograma.length) {
    section('Cronograma');
    cronograma.forEach(([hito, detalle]) => {
      doc.font('Helvetica-Bold').text(hito, { continued: true }).font('Helvetica').text('  —  ' + detalle);
    });
  }

  doc.moveDown(2);
  doc.fontSize(8).fillColor(GRIS).font('Helvetica-Oblique')
    .text('Documento generado por SORY, asistente de IA de Fondos Sin Fronteras AI. Revisar antes de enviar al cooperante.');

  doc.end();
}

module.exports = { streamProjectPDF };
