// « Ajouter une maquette… » et « Comparer avec… » : lire un fichier de plus (glb, gltf, usd ou ifc converti) et l'ajouter
// au modèle ouvert (voir data/federation.ts). Les propriétés, l'historique, la sélection et les masquages suivent par
// `App.changeParts`, comme après un découpage. Le fichier Revit n'est pas accepté ici : son lecteur construit le modèle
// morceau par morceau avec son propre budget, ce qui ne se branche pas encore sur un modèle déjà ouvert.

import { IFC_READ_ONLY, type Metadata } from '../data/metadata.ts';
import { chooseMetadata, orphanNotice } from '../data/sidecar.ts';
import { FederationError, MODEL_PROPERTY, addSource, framesNotice, rekeyMetadata, removeLastSource, sourceIndexOf, type ModelSourceInfo } from '../data/federation.ts';
import { integer, plural, s } from '../data/text.ts';
import { gltfSource, type ModelSource } from '../engine/buildModel.ts';
import { fileKind, isIfcFile, isJsonFile, isModelFile, isRevitFile, isUsdFile, withoutExtension } from '../engine/fileKinds.ts';
import { loadModelFiles, type InputFile } from '../engine/loadModel.ts';
import { convertIfc } from '../ifc/convertIfc.ts';
import { deviceTriangleBudget } from '../revit/readRevit.ts';
import { loadUsdFile } from '../usd/loadUsd.ts';
import type { App } from './App.ts';

export const REVIT_REFUSED = 'Un fichier Revit ne s’ajoute pas encore à une maquette ouverte : ouvrez-le seul, ou ajoutez sa version IFC.';

const kindOf = (name: string): ModelSourceInfo['kind'] => {
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

/**
 * Ajoute la maquette des fichiers déposés (un modèle, et ses JSON) au modèle ouvert. `role` : `reference` pour l'ancienne
 * version d'une comparaison. Rend la maquette ajoutée, ou null (refus ou erreur : déjà dits à l'utilisateur).
 */
export async function addModelFiles(app: App, inputs: InputFile[], role: ModelSourceInfo['role'] = 'model'): Promise<ModelSourceInfo | null> {
  const fail = (text: string) => {
    app.toast(text, true);
    return null;
  };
  const blocked = federationBlocked(app);
  if (blocked) return fail(blocked);
  const model = app.model!;
  const depth = (input: InputFile) => input.path.split('/').length;
  const byDepth = (list: InputFile[]) => list.sort((a, b) => depth(a) - depth(b));
  const file = byDepth(inputs.filter((input) => isModelFile(input.file.name) || isUsdFile(input.file.name)))[0]
    ?? byDepth(inputs.filter((input) => isIfcFile(input.file.name)))[0];
  if (!file) return fail(inputs.some((input) => isRevitFile(input.file.name)) ? REVIT_REFUSED : 'Choisissez un fichier .ifc, .glb, .gltf ou .usdz à ajouter, avec éventuellement son .json.');
  const name = file.file.name;
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
    let geometry: ModelSource;
    let own: Metadata | null = null;
    if (isUsdFile(name)) {
      const usd = await loadUsdFile(file.file);
      if (usd.metadata) candidates.push({ ...usd.metadata, source: `${name} (embarquées)` });
      geometry = usd.source;
    } else if (isIfcFile(name)) {
      const result = await convertIfc(file.file, (message) => app.busy(message));
      own = app.readMetadata(result.metadata, `${withoutExtension(name)}.json`);
      const glb = new File([result.glb], `${withoutExtension(name)}.glb`, { type: 'model/gltf-binary' });
      geometry = gltfSource((await loadModelFiles({ file: glb, path: glb.name }, [])).gltf);
    } else {
      geometry = gltfSource((await loadModelFiles(file, inputs.filter((input) => input !== file))).gltf);
    }
    // Un autre modèle a été ouvert pendant la lecture : l'ajout est abandonné.
    if (app.model !== model || app.mapOpen) return null;
    app.busy('Ajout de la géométrie…');
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (app.model !== model || app.mapOpen) return null;
    const added = addSource({
      model, splits: app.splits!, selectColor: app.viewer.selectColor, original: originalOf(app),
      first: { name: app.sourceName, kind: kindOf(app.sourceName) }, maxTriangles: deviceTriangleBudget(),
    }, { name, kind: kindOf(name), role, geometry });

    // Ses métadonnées : la base qui décrit le plus de ses éléments, puis ses JSON de modifications (des étapes annulables).
    const { metadata, overlays } = chooseMetadata(own, candidates, [...added.keyMap.keys()]);
    app.changeParts(added.change, metadata ? rekeyMetadata(metadata, added.keyMap) : null);
    const locks = metadata?.readOnly ?? (kindOf(name) === 'ifc' ? IFC_READ_ONLY : []);
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
    if (added.prefixed > 0) notes.push(`${plural(added.prefixed, 'identifiant')} déjà pris par une autre maquette : préfixé${s(added.prefixed)} « ${source.id}| » dans cette session (les exports gardent les clés du fichier).`);
    if (!metadata && metadataError) notes.push(`JSON non pris en compte. ${metadataError}`);
    const frames = framesNotice(added.apart, name);
    if (frames) notes.push(frames);
    app.toast(notes.join(' '), frames !== '' || (!metadata && metadataError !== ''));
    return source;
  } catch (error) {
    if (error instanceof FederationError) return fail(error.message);
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
