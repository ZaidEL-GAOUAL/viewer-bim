import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latin1, makePdf } from '../src/data/pdf.ts';

type Call = [string, ...unknown[]];

/** Un faux jsPDF qui note ses appels. */
function fake() {
  const calls: Call[] = [];
  const doc = new Proxy({}, {
    get: (_target, name: string) => (...args: unknown[]) => {
      calls.push([name, ...args]);
      return name === 'output' ? new Blob(['pdf']) : doc;
    },
  });
  const constructed: unknown[] = [];
  class Fake {
    constructor(options: unknown) {
      constructed.push(options);
      return doc as object;
    }
  }
  return { Ctor: Fake as never, calls, constructed };
}

test('the first page creates the document in millimetres, the next ones add pages of their own size', () => {
  const { Ctor, calls, constructed } = fake();
  const pdf = makePdf(Ctor);
  pdf.addPage(420, 297);
  pdf.addPage(210, 297);
  assert.deepEqual(constructed, [{ unit: 'mm', format: [297, 420], orientation: 'landscape', compress: true }]);
  assert.deepEqual(calls.find(([name]) => name === 'addPage'), ['addPage', [210, 297], 'portrait']);
});

test('an image is placed at its millimetre rectangle, a line at its millimetre ends', () => {
  const { Ctor, calls } = fake();
  const pdf = makePdf(Ctor);
  pdf.addPage(420, 297);
  const bytes = new Uint8Array([1, 2, 3]);
  pdf.image(bytes, 'JPEG', 10, 20, 204.8, 100);
  pdf.setLine(0.35);
  pdf.line(1, 2, 3, 4);
  const image = calls.find(([name]) => name === 'addImage')!;
  assert.equal(image[1], bytes);
  assert.deepEqual(image.slice(2, 7), ['JPEG', 10, 20, 204.8, 100]);
  assert.deepEqual(calls.find(([name]) => name === 'setLineWidth'), ['setLineWidth', 0.35]);
  assert.deepEqual(calls.find(([name]) => name === 'line'), ['line', 1, 2, 3, 4]);
});

test('line widths never go under 0.13 mm', () => {
  const { Ctor, calls } = fake();
  const pdf = makePdf(Ctor);
  pdf.addPage(210, 297);
  pdf.setLine(0.01);
  assert.deepEqual(calls.find(([name]) => name === 'setLineWidth'), ['setLineWidth', 0.13]);
});

test('text keeps accents and drops what WinAnsi cannot show', () => {
  assert.equal(latin1('Étage 1 — plan d’étage…'), 'Étage 1 - plan d\'étage...');
  assert.equal(latin1('日本'), '??');
  assert.equal(latin1('Gros œuvre : Ouverte → En cours'), 'Gros oeuvre : Ouverte -> En cours');
});

test('finishing gives the PDF as a blob', () => {
  const { Ctor } = fake();
  const pdf = makePdf(Ctor);
  pdf.addPage(210, 297);
  assert.ok(pdf.finish() instanceof Blob);
});
