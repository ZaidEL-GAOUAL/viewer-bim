// Les métadonnées à l'ouverture d'un modèle, et le JSON de modifications (« sidecar ») : ce que l'utilisateur a changé,
// écrit à part du fichier source, qui n'est jamais modifié. Voir docs/contrat-metadonnees.md, § 2 bis.

import { fileKind } from '../engine/fileKinds.ts';
import { IFC_READ_ONLY, PropertyStore, flattenProperties, mergeProperties, type Metadata } from './metadata.ts';
import type { PropertyEdits } from './PropertyEdits.ts';
import { integer, s } from './text.ts';

/** Nombre d'éléments du modèle (`keys`) que décrit `metadata`. */
export function countMatches(metadata: Metadata, keys: readonly string[]): number {
  let matched = 0;
  for (const key of keys) if (metadata.elements.has(key)) matched++;
  return matched;
}

/**
 * Les métadonnées d'ouverture d'un modèle. `own` : celles que son fichier donne lui-même (lecture d'un .rvt, conversion d'un
 * .ifc), sinon null ; `dropped` : les JSON déposés avec lui. La base est le meilleur JSON complet ; un instantané
 * (`propertiesMode: "replace"`) déposé avec le modèle l'emporte à égalité sur ses métadonnées propres, mais les vues, les
 * phases, la position et les verrous restent ceux du fichier, relus frais. Les JSON de modifications (`overlays`) ne
 * concourent jamais : ils s'appliquent par-dessus la base, par ordre de nom. Sans métadonnées propres (un glb), un JSON en mode
 * fusion qui ne dit pas être des modifications (`source`) complète le modèle comme avant.
 */
export function chooseMetadata(own: Metadata | null, dropped: readonly Metadata[], keys: readonly string[]): { metadata: Metadata | null; overlays: Metadata[] } {
  const isOverlay = (candidate: Metadata) => candidate.propertiesMode !== 'replace' && (own !== null || candidate.modifies !== undefined);
  const overlays = dropped.filter(isOverlay).sort((a, b) => (a.source ?? '').localeCompare(b.source ?? '', 'fr', { numeric: true }));
  const full = dropped.filter((candidate) => !isOverlay(candidate));
  let base = own ?? full[0] ?? null;
  let best = base ? countMatches(base, keys) : 0;
  for (const candidate of own ? full : full.slice(1)) {
    const matches = countMatches(candidate, keys);
    if (matches > best || (matches === best && base === own)) {
      base = candidate;
      best = matches;
    }
  }
  if (!own || !base || base === own) return { metadata: base, overlays };
  return { metadata: { ...base, readOnly: own.readOnly ?? base.readOnly, georeference: own.georeference ?? base.georeference, phases: own.phases ?? base.phases, views: own.views ?? base.views }, overlays };
}

/** Les propriétés d'ouverture : les `extras` de chaque élément complétés par le JSON, ou remplacés par un instantané. */
export function buildStore(keys: readonly string[], extras: readonly (Record<string, unknown> | undefined)[], metadata: Metadata | null): PropertyStore {
  const store = new PropertyStore(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const entry = metadata?.elements.get(keys[i]);
    const embedded = extras[i];
    const props = entry && metadata?.propertiesMode === 'replace' ? entry.props : mergeProperties(embedded ? flattenProperties(embedded) : undefined, entry?.props);
    if (props) store.set(i, props, entry?.label);
  }
  store.finalize();
  // Le fichier dit ce qui est verrouillé ; à défaut, des métadonnées issues d'un IFC (par un convertisseur plus ancien) gardent
  // les verrous habituels.
  store.readOnly = metadata?.readOnly ?? (store.paths.includes('Classe IFC') ? [...IFC_READ_ONLY] : []);
  return store;
}

/**
 * Applique les JSON de modifications sur le modèle ouvert : chacun est un import (une étape annulable), donc ses valeurs sont des
 * modifications du fichier, que le prochain export de modifications garde. Rend un message par JSON dont la plupart des éléments
 * manquent au modèle.
 */
export function applyOverlays(edits: PropertyEdits, overlays: readonly Metadata[], keys: readonly string[]): string[] {
  const notices: string[] = [];
  for (const overlay of overlays) {
    edits.import(overlay, keys);
    const notice = orphanNotice(overlay, keys);
    if (notice) notices.push(notice);
  }
  // Ces modifications sont déjà dans un fichier : rien de neuf à enregistrer.
  edits.markSaved();
  return notices;
}

/** « « x.json » : 12 éléments modifiés sur 40 introuvables dans ce modèle. » quand moins de la moitié s'y trouve, sinon rien. */
export function orphanNotice(overlay: Metadata, keys: readonly string[]): string {
  const total = overlay.elements.size, missing = total - countMatches(overlay, keys);
  if (missing * 2 <= total) return '';
  return `« ${overlay.source ?? 'JSON'} » : ${integer.format(missing)} élément${s(missing)} modifié${s(missing)} sur ${integer.format(total)} introuvable${s(missing)} dans ce modèle.`;
}

/** Le JSON « Modifications » : ce qui diffère du fichier source `sourceName`, en mode fusion, avec le fichier qu'il complète. */
export function modificationsFile(edits: PropertyEdits, keys: readonly string[], sourceName: string): Record<string, unknown> {
  const { version, elements } = edits.diff(keys);
  const kind = fileKind(sourceName);
  const source = kind && kind !== 'json' ? { name: sourceName, kind: kind === 'gltf' ? 'glb' : kind } : undefined;
  return { version, ...(source ? { source } : {}), elements };
}
