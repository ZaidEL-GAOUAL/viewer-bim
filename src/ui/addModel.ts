// « Ajouter une maquette… » et « Comparer avec… » : lire un fichier de plus (glb, gltf, usd, ifc converti ou fichier Revit
// lu) et l'ajouter au modèle ouvert (voir data/federation.ts). Les propriétés, l'historique, la sélection et les masquages
// suivent par `App.changeParts`, comme après un découpage. Un fichier Revit est lu en entier (sans affichage par morceaux),
// avec ce qui reste du budget de triangles de l'appareil après les maquettes déjà affichées.

import { IFC_READ_ONLY, type Metadata } from '../data/metadata.ts';
import { chooseMetadata, metadataUse, orphanNotice } from '../data/sidecar.ts';
import { FederationError, MODEL_PROPERTY, addSource, framesNotice, generatorOf, producerOf, rekeyMetadata, removeLastSource, revitBudget, sourceIndexOf, trianglesText, type ModelSourceInfo } from '../data/federation.ts';
import { integer, plural, s } from '../data/text.ts';
import { gltfSource, type ModelSource, type RawInput } from '../engine/buildModel.ts';
import { fileKind, isIfcFile, isJsonFile, isModelFile, isRevitFile, isUsdFile, withoutExtension } from '../engine/fileKinds.ts';
import { parseGlb } from '../engine/glbFile.ts';
import { loadModelFiles, type InputFile } from '../engine/loadModel.ts';
import { convertIfc } from '../ifc/convertIfc.ts';
import { RevitTooLargeError, deviceTriangleBudget, isMemoryFailure, readRevit, revitFailureToError } from '../revit/readRevit.ts';
import { describeRevitReport } from '../revit/revitReport.ts';
import { loadUsdFile } from '../usd/loadUsd.ts';
import type { App } from './App.ts';

export const kindOf = (name: string): ModelSourceInfo['kind'] => {
  const kind = fileKind(name);
  return kind === 'ifc' || kind === 'revit' || kind === 'usd' ? kind : 'glb';
};

let adding = false;

/** Pourquoi on ne peut pas ajouter (ou retirer) une maquette en ce moment, ou rien. */
export function federationBlocked(app: App): string {
  if (!app.model || !app.splits || !app.propertyEdits) return 'Ouvrez d’abord une maquette.';
  if (app.mapOpen) return 'Fermez la carte : le globe dessine sa propre copie de la maquette, qui ne suit pas les maquettes ajoutées.';
  if (adding) return 'Une maquette est déjà en cours d’ajout.';
  return '';
}

/** Ce que les pièces reprennent de leur original quand elles sont remises après un ajout ou un retrait. */
const originalOf = (app: App) => (i: number) => ({ props: app.store.propsOf(i), label: app.elementLabel(i) });

/** Le nom de la maquette de chaque élément, dans la propriété `Modèle` (retirée revenu à une seule maquette). */
function stampModels(app: App): void {
  const model = app.model!;
  app.store.readOnly = model.sources.length > 0 ? [...new Set([...app.store.readOnly, MODEL_PROPERTY])] : app.store.readOnly.filter((pattern) => pattern !== MODEL_PROPERTY);
  app.propertyEdits!.stamp(MODEL_PROPERTY, (i) => model.sources[sourceIndexOf(model, i)]?.name);
}

export interface AddOptions {
  /** Où dire ce que l'ajout a donné (`error` : à montrer comme une erreur) ; un message de l'application par défaut. */
  report?: (text: string, error: boolean) => void;
  /** Triangles au plus pour toutes les maquettes réunies : le budget de l'appareil par défaut. */
  maxTriangles?: number;
}

/**
 * Ajoute la maquette des fichiers déposés (un modèle, et ses JSON) au modèle ouvert. `role` : `reference` pour l'ancienne
 * version d'une comparaison. Rend la maquette ajoutée, ou null (refus, arrêt ou erreur : déjà dits par `options.report`).
 */
export async function addModelFiles(app: App, inputs: InputFile[], role: ModelSourceInfo['role'] = 'model', options: AddOptions = {}): Promise<ModelSourceInfo | null> {
  const report = options.report ?? ((text: string, error: boolean) => app.toast(text, error));
  const fail = (text: string) => {
    report(text, true);
    return null;
  };
  const blocked = federationBlocked(app);
  if (blocked) return fail(blocked);
  const model = app.model!;
  const maxTriangles = options.maxTriangles ?? deviceTriangleBudget();
  const depth = (input: InputFile) => input.path.split('/').length;
  const byDepth = (list: InputFile[]) => list.sort((a, b) => depth(a) - depth(b));
  const file = byDepth(inputs.filter((input) => isModelFile(input.file.name) || isUsdFile(input.file.name)))[0]
    ?? byDepth(inputs.filter((input) => isIfcFile(input.file.name)))[0]
    ?? byDepth(inputs.filter((input) => isRevitFile(input.file.name)))[0];
  if (!file) return fail('Choisissez un fichier .ifc, Revit (.rvt, .rfa), .glb, .gltf ou .usdz à ajouter, avec éventuellement son .json.');
  const name = file.file.name;
  const kind = kindOf(name);
  const controller = new AbortController();
  adding = true;
  app.busy(`Lecture de « ${name} »…`);
  try {
    const candidates: Metadata[] = [];
    let metadataError = '';
    for (const input of inputs.filter((item) => isJsonFile(item.file.name))) {
      try {
        candidates.push(app.readMetadata(await input.file.text(), input.file.name));
      } catch (error) {
        metadataError ||= `« ${input.file.name} » : ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    let geometry: ModelSource | RawInput;
    let own: Metadata | null = null;
    let generator: string | undefined;
    let readNote = '';
    if (isUsdFile(name)) {
      const usd = await loadUsdFile(file.file);
      if (usd.metadata) candidates.push({ ...usd.metadata, source: `${name} (embarquées)` });
      geometry = usd.source;
    } else if (isIfcFile(name)) {
      const result = await convertIfc(file.file, (message) => app.busy(message));
      own = app.readMetadata(result.metadata, `${withoutExtension(name)}.json`);
      generator = generatorOf(parseGlb(result.glb).json);
      const glb = new File([result.glb], `${withoutExtension(name)}.glb`, { type: 'model/gltf-binary' });
      geometry = gltfSource((await loadModelFiles({ file: glb, path: glb.name }, [])).gltf);
    } else if (kind === 'revit') {
      // Ce que les maquettes affichées laissent du budget, dit avant la lecture ; au-delà, le lecteur montre des boîtes.
      const budget = revitBudget(name, maxTriangles, model.triangleCount);
      const figures = `Budget de cette maquette : ${trianglesText(budget)} (l’appareil en permet ${trianglesText(maxTriangles)}, dont ${trianglesText(model.triangleCount)} déjà affichés).`;
      const read = await readRevit(file.file, (message) => app.busy(`${message} ${figures}`, () => controller.abort()), controller.signal, undefined, budget);
      own = app.readMetadata(read.metadata, `${withoutExtension(name)}.json`);
      geometry = read.raw;
      const described = describeRevitReport(read.report);
      if (described.warning) readNote = described.text;
    } else {
      const { gltf } = await loadModelFiles(file, inputs.filter((input) => input !== file));
      generator = generatorOf(gltf.parser.json);
      geometry = gltfSource(gltf);
    }
    // Un autre modèle a été ouvert pendant la lecture : l'ajout est abandonné.
    if (app.model !== model || app.mapOpen) return null;
    app.busy('Ajout de la géométrie…');
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (app.model !== model || app.mapOpen) return null;
    const added = addSource({
      model, splits: app.splits!, selectColor: app.viewer.selectColor, original: originalOf(app),
      first: { name: app.sourceName, kind: kindOf(app.sourceName), origin: app.sourceOrigin ?? undefined }, maxTriangles,
    }, { name, kind, role, geometry });

    // Ses métadonnées : la base qui décrit le plus de ses éléments, puis ses JSON de modifications (des étapes annulables).
    const { metadata, overlays } = chooseMetadata(own, candidates, [...added.keyMap.keys()]);
    added.source.origin = { ...producerOf(kind, generator), metadata: metadataUse(own, metadata, overlays) };
    app.changeParts(added.change, metadata ? rekeyMetadata(metadata, added.keyMap) : null);
    const locks = metadata?.readOnly ?? (kind === 'ifc' ? IFC_READ_ONLY : []);
    app.store.readOnly = [...new Set([...app.store.readOnly, ...locks])];
    const notes: string[] = [];
    for (const overlay of overlays) {
      const rekeyed = rekeyMetadata(overlay, added.keyMap);
      app.propertyEdits!.import(rekeyed, model.keys);
      const orphans = orphanNotice(overlay, [...added.keyMap.keys()]);
      if (orphans) notes.push(orphans);
    }
    stampModels(app);

    const { source } = added;
    notes.unshift(`« ${source.name} » ajouté${role === 'reference' ? ' comme version de référence' : ''} : ${plural(source.count, 'élément')}, ${integer.format(source.triangles)} triangles.`);
    if (readNote) notes.push(readNote);
    if (added.prefixed > 0) notes.push(`${plural(added.prefixed, 'identifiant')} déjà pris par une autre maquette : préfixé${s(added.prefixed)} « ${source.id}| » dans cette session (les exports gardent les clés du fichier).`);
    if (!metadata && metadataError) notes.push(`JSON non pris en compte. ${metadataError}`);
    const frames = framesNotice(added.apart, name);
    if (frames) notes.push(frames);
    report(notes.join(' '), frames !== '' || readNote !== '' || (!metadata && metadataError !== ''));
    return source;
  } catch (error) {
    if (controller.signal.aborted) {
      report(`Ajout de « ${name} » arrêté : rien n’a changé.`, false);
      return null;
    }
    if (error instanceof FederationError || error instanceof RevitTooLargeError) return fail(error.message);
    // Construire le modèle d'un gros fichier Revit peut épuiser la mémoire du fil principal : même message que dans le lecteur.
    if (kind === 'revit' && error instanceof Error && isMemoryFailure(error)) return fail(revitFailureToError(file.file, error).message);
    return fail(`« ${name} » n’a pas pu être ajouté : ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    adding = false;
    app.busy(null);
  }
}

/** Retire la dernière maquette ajoutée ; ses modifications de propriétés sont perdues (l'utilisateur l'a confirmé). */
export function removeLastModel(app: App): void {
  const model = app.model;
  if (federationBlocked(app) || !model) return;
  const last = model.sources[model.sources.length - 1];
  if (!last) return;
  app.changeParts(removeLastSource(model, app.splits!, originalOf(app)));
  stampModels(app);
  app.toast(`« ${last.name} » retiré.`);
}
