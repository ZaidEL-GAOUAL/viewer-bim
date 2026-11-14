// Le rapport des observations en PDF (A4 portrait, fond blanc) : un tableau récapitulatif d'abord, puis une fiche par
// observation, groupées par entreprise puis par niveau (image du point de vue avec son repère, première photo, titre, statut,
// échéance, description). Mise en page calculée dans data/sheet.ts (`flowLayout`, `wrapText`), écriture par data/pdf.ts.
// Les images entrent une à une dans le PDF.

import { imageSize } from '../data/bcf.ts';
import { frenchDate, groupObservations, statusColor, type Observation, type ObservationLists } from '../data/observations.ts';
import { hexToRgb } from '../data/palette.ts';
import { loadPdf, type PdfWriter } from '../data/pdf.ts';
import { fitRect, flowLayout, wrapText, type Rect } from '../data/sheet.ts';

const PAGE = { width: 210, height: 297 }, MARGIN = 12, WIDTH = PAGE.width - 2 * MARGIN;
/** La zone des contenus de chaque page : sous l'en-tête, au-dessus du pied. */
const AREA = { top: 30, bottom: 282 };
const ROW = 5.5;
const COLUMNS: { label: string; width: number; value: (topic: Observation) => string }[] = [
  { label: 'N°', width: 12, value: (topic) => String(topic.number) },
  { label: 'Titre', width: 66, value: (topic) => topic.title || '(sans titre)' },
  { label: 'Statut', width: 22, value: (topic) => topic.status },
  { label: 'Entreprise', width: 36, value: (topic) => topic.assignedTo ?? '' },
  { label: 'Niveau', width: 28, value: (topic) => topic.location.level ?? '' },
  { label: 'Échéance', width: 22, value: (topic) => frenchDate(topic.dueDate) },
];
const IMAGE = { width: 90, height: 56 };
const DESCRIPTION_LINES = 4;

async function drawImage(pdf: PdfWriter, blob: Blob | undefined, box: Rect, missing: string): Promise<void> {
  pdf.setColor([200, 200, 200]);
  pdf.setLine(0.2);
  pdf.rect(box.x, box.y, box.width, box.height);
  const bytes = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  const size = bytes ? imageSize(bytes) : null;
  if (!bytes || !size) {
    pdf.setColor([130, 130, 130]);
    pdf.text(missing, box.x + box.width / 2, box.y + box.height / 2, { size: 8, align: 'center' });
    return;
  }
  const fit = fitRect(size.width / size.height, box, 0);
  pdf.image(bytes, size.type === 'png' ? 'PNG' : 'JPEG', box.x + fit.x, box.y + fit.y, fit.width, fit.height);
}

/** Le PDF des observations données (déjà filtrées et triées). */
export async function observationsPdf(topics: readonly Observation[], lists: ObservationLists, info: { title: string; author: string }, onProgress: (text: string) => void = () => {}): Promise<Blob> {
  const pdf = await loadPdf();
  let pages = 0;
  const newPage = () => {
    pdf.addPage(PAGE.width, PAGE.height);
    pages++;
    pdf.setColor([0, 0, 0]);
    pdf.text(`Observations - ${info.title}`, MARGIN, 16, { size: 13, bold: true });
    pdf.setColor([110, 110, 110]);
    pdf.text(`Édité le ${new Date().toLocaleDateString('fr-FR')}${info.author ? ` par ${info.author}` : ''} · ${topics.length} observation${topics.length > 1 ? 's' : ''}`, MARGIN, 22, { size: 8 });
    pdf.text(`Page ${pages}`, PAGE.width - MARGIN, 290, { size: 7, align: 'right' });
    pdf.setLine(0.3);
    pdf.line(MARGIN, 25, PAGE.width - MARGIN, 25);
  };

  // 1. Le tableau récapitulatif, son en-tête répété en haut de chaque page.
  const header = (y: number) => {
    pdf.setColor([235, 237, 240]);
    pdf.rect(MARGIN, y, WIDTH, ROW, true);
    pdf.setColor([0, 0, 0]);
    let x = MARGIN;
    for (const column of COLUMNS) {
      pdf.text(column.label, x + 1, y + 3.8, { size: 7.5, bold: true });
      x += column.width;
    }
  };
  const rows = flowLayout(topics.map(() => ({ height: ROW })), { top: AREA.top + ROW, bottom: AREA.bottom });
  let page = -1;
  topics.forEach((topic, i) => {
    if (rows[i].page !== page) {
      page = rows[i].page;
      newPage();
      header(AREA.top);
    }
    const y = rows[i].y;
    let x = MARGIN;
    for (const column of COLUMNS) {
      if (column.label === 'Statut') {
        pdf.setColor(hexToRgb(statusColor(topic.status, lists)));
        pdf.rect(x + 1, y + 1.6, 2.2, 2.2, true);
      }
      pdf.setColor([0, 0, 0]);
      const indent = column.label === 'Statut' ? 4.2 : 1;
      pdf.text(wrapText(column.value(topic), column.width - indent - 1, 7.5, 1)[0] ?? '', x + indent, y + 3.8, { size: 7.5 });
      x += column.width;
    }
    pdf.setColor([220, 220, 220]);
    pdf.setLine(0.15);
    pdf.line(MARGIN, y + ROW, MARGIN + WIDTH, y + ROW);
  });
  if (topics.length === 0) {
    newPage();
    pdf.text('Aucune observation.', MARGIN, AREA.top + 6, { size: 10 });
  }

  // 2. Les fiches, par entreprise puis par niveau.
  type Item = { height: number; keepWithNext?: boolean; draw: (y: number) => Promise<void> | void };
  const items: Item[] = [];
  for (const company of groupObservations(topics, 'company', lists.companies)) {
    items.push({ height: 9, keepWithNext: true, draw: (y) => { pdf.setColor([0, 0, 0]); pdf.text(company.label, MARGIN, y + 6, { size: 12, bold: true }); } });
    for (const level of groupObservations(company.topics, 'level')) {
      items.push({ height: 7, keepWithNext: true, draw: (y) => { pdf.setColor([60, 60, 60]); pdf.text(level.label, MARGIN, y + 5, { size: 10, bold: true }); } });
      for (const topic of level.topics) {
        const description = wrapText(topic.description ?? '', WIDTH, 8.5, DESCRIPTION_LINES);
        items.push({ height: 13 + IMAGE.height + 2 + description.length * 4 + 3, draw: async (y) => {
          onProgress(`Rapport : observation ${topic.number}`);
          pdf.setColor(hexToRgb(statusColor(topic.status, lists)));
          pdf.rect(MARGIN, y + 1.6, 3, 3, true);
          pdf.setColor([0, 0, 0]);
          pdf.text(wrapText(`N° ${topic.number} - ${topic.title || '(sans titre)'}`, WIDTH - 5, 10, 1)[0], MARGIN + 5, y + 4.4, { size: 10, bold: true });
          const facts = [topic.status, topic.dueDate ? `échéance ${frenchDate(topic.dueDate)}` : 'sans échéance', topic.type, topic.priority, topic.labels.join(', '), topic.stage, topic.location.room, topic.location.zone].filter(Boolean).join(' · ');
          pdf.setColor([90, 90, 90]);
          pdf.text(wrapText(facts, WIDTH, 8, 1)[0] ?? '', MARGIN, y + 9.5, { size: 8 });
          const top = y + 12;
          const photo = topic.documents.find((document) => document.data && /^image\/(jpeg|png)$/.test(document.data.type));
          await drawImage(pdf, topic.viewpoints[0]?.snapshot, { x: MARGIN, y: top, ...IMAGE }, 'Vue dans le .bcf');
          await drawImage(pdf, photo?.data, { x: MARGIN + WIDTH - IMAGE.width, y: top, ...IMAGE }, topic.documents.length > 0 ? 'Photo dans le .bcf' : 'Pas de photo');
          pdf.setColor([0, 0, 0]);
          description.forEach((line, i) => pdf.text(line, MARGIN, top + IMAGE.height + 5 + i * 4, { size: 8.5 }));
        } });
      }
    }
  }
  const placed = flowLayout(items, AREA, 3);
  const first = pages;
  for (let i = 0; i < items.length; i++) {
    while (pages - first <= placed[i].page) newPage();
    await items[i].draw(placed[i].y);
  }
  return pdf.finish();
}
