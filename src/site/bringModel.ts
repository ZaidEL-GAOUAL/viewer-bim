// « Ajouter une maquette » sur le site d'une étude : les formats du viewer, lus par les mêmes chargeurs (Revit natif,
// IFC converti sur place, glb / gltf avec leur JSON, usdz), cuits par `buildModel` puis réduits à leur géométrie
// (placedModel.ts). Chargé à la demande : la page de l'étude ne télécharge rien de tout cela tant qu'on n'ajoute rien.

import { Color } from 'three';
import { integer } from '../data/text.ts';
import { buildModel, gltfSource } from '../engine/buildModel.ts';
import { isIfcFile, isJsonFile, isModelFile, isRevitFile, isUsdFile, withoutExtension } from '../engine/fileKinds.ts';
import { loadModelFiles, type InputFile } from '../engine/loadModel.ts';
import { parseGeoreference, type Georeference } from '../geo/georeference.ts';
import { convertIfc } from '../ifc/convertIfc.ts';
import { deviceTriangleBudget, readRevit } from '../revit/readRevit.ts';
import { loadUsdFile } from '../usd/loadUsd.ts';
import { snapshotOf, type ModelSnapshot } from './placedModel.ts';

const millions = (triangles: number) => `${(triangles / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} million${triangles >= 2e6 ? 's' : ''}`;
const triangleText = (triangles: number) => (triangles >= 1e6 ? `${millions(triangles)} de triangles` : `${integer.format(triangles)} triangles`);

/** La géoréférence d'un JSON de métadonnées (texte), ou null. */
function georeferenceOf(text: string): Georeference | null {
  try {
    return parseGeoreference((JSON.parse(text) as { georeference?: unknown }).georeference);
  } catch {
    return null;
  }
}

/**
 * Lit la maquette des fichiers choisis (un modèle et, pour un glb ou un gltf, son JSON et ses fichiers voisins). `used` :
 * triangles déjà posés sur le site ; la page ne dépasse pas le budget de l'appareil (celui du viewer) et refuse, chiffres
 * à l'appui, une maquette qui n'y tient plus.
 */
export async function readModelFiles(files: readonly File[], onStatus: (message: string) => void, used: number): Promise<ModelSnapshot> {
  const inputs: InputFile[] = files.map((file) => ({ file, path: file.webkitRelativePath || file.name }));
  const pick = (test: (name: string) => boolean) => inputs.find((input) => test(input.file.name));
  const main = pick(isRevitFile) ?? pick(isIfcFile) ?? pick(isUsdFile) ?? pick(isModelFile);
  if (!main) throw new Error('Choisissez un fichier de maquette : .rvt (Revit), .ifc, .glb ou .gltf (avec son .json), ou .usdz.');
  const budget = deviceTriangleBudget() - used;
  if (budget <= 0) throw new Error(`Les maquettes déjà posées remplissent la place de cette page (${triangleText(used)}) : retirez-en une avant d’en ajouter une autre.`);
  const name = main.file.name;
  let georeference: Georeference | null = null;
  for (const input of inputs.filter((item) => isJsonFile(item.file.name))) georeference ??= georeferenceOf(await input.file.text());

  const selectColor = { value: new Color(0x1d8bff) };
  onStatus(`Lecture de « ${name} »…`);
  let model;
  if (isRevitFile(name)) {
    // Lu avec ce qui reste du budget de la page : au-delà, le lecteur pose des boîtes et le dit (voir readRevit).
    const read = await readRevit(main.file, onStatus, undefined, undefined, budget);
    georeference ??= georeferenceOf(read.metadata);
    model = buildModel(read.raw, selectColor);
  } else if (isIfcFile(name)) {
    const result = await convertIfc(main.file, onStatus);
    georeference ??= georeferenceOf(result.metadata);
    const glb = new File([result.glb], `${withoutExtension(name)}.glb`, { type: 'model/gltf-binary' });
    model = buildModel((await loadModelFiles({ file: glb, path: glb.name }, [])).gltf, selectColor);
  } else if (isUsdFile(name)) {
    const usd = await loadUsdFile(main.file);
    georeference ??= usd.metadata?.georeference ?? null;
    model = buildModel(usd.source, selectColor);
  } else {
    model = buildModel(gltfSource((await loadModelFiles(main, inputs.filter((input) => input !== main))).gltf), selectColor);
  }
  try {
    if (model.triangleCount > budget) {
      throw new Error(`« ${name} » compte ${triangleText(model.triangleCount)} ; cette page en tient encore ${triangleText(budget)} (selon la mémoire de l’appareil). Allégez la maquette (un seul bâtiment, sans liens) ou retirez une maquette déjà posée.`);
    }
    return snapshotOf(model, withoutExtension(name), georeference);
  } finally {
    // La géométrie est reprise telle quelle par l'instantané ; seuls les objets de dessin du viewer sont libérés.
    model.dispose();
  }
}
