// Plusieurs maquettes dans une même scène (voir docs/contrat-metadonnees.md, § « Plusieurs maquettes ») : une maquette
// ajoutée prolonge le modèle ouvert et ses propriétés, comme les morceaux d'un fichier Revit ou les pièces d'un découpage.
// Ses éléments prennent les numéros suivants (les pièces restent à la fin, voir `SplitSet.reshape`) ; chacun reçoit la
// propriété `Modèle` (le nom de son fichier) et appartient à une maquette (`Model.sources`).
//
// Clés : celles du fichier de chaque maquette. Une clé déjà prise par une maquette précédente devient `<id>|<clé>` (le cas
// normal en comparant deux versions) ; les maquettes déjà ouvertes ne changent jamais de clés. Les exports par maquette
// (`documentsBySource`) rendent à chacune ses clés d'origine.
//
// Repère : un seul, celui de la première maquette (`Model.offset`). Les suivantes sont placées par leurs coordonnées
// d'origine, jamais recentrées sur elles-mêmes.
//
// Restrictions : seule la dernière maquette ajoutée se retire (les numéros des autres ne bougent jamais) ; le découpage en
// pièces ne porte que sur la première.

import { Box3, Vector3, type Color, type IUniform } from 'three';
import { ModelBuilder, collect, type ModelSource, type RawModel } from '../engine/buildModel.ts';
import type { Model, ModelSourceInfo } from '../engine/Model.ts';
import { isRecord } from './json.ts';
import type { Metadata, MetadataEntry } from './metadata.ts';
import type { OriginalOf, SplitSet, TailChange } from './splits.ts';
import { integer } from './text.ts';

export type { ModelSourceInfo } from '../engine/Model.ts';

/** La propriété que chaque élément reçoit dans une session à plusieurs maquettes : le nom du fichier de sa maquette. */
export const MODEL_PROPERTY = 'Modèle';
export const KEY_SEPARATOR = '|';

const millions = (n: number) => `${(n / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} million${n >= 2e6 ? 's' : ''}`;

/** La maquette d'un élément (les pièces sont celles de leur original), ou −1 hors session à plusieurs maquettes. */
export function sourceIndexOf(model: Model, element: number): number {
  const original = model.parents[element] >= 0 ? model.parents[element] : element;
  return model.sources.findIndex((source) => original >= source.start && original < source.start + source.count);
}

/** La clé d'un élément dans le fichier de sa maquette : sans le préfixe `<id>|` qu'une collision lui a donné. */
export function sourceKey(flat: string, source: ModelSourceInfo | undefined): string {
  const prefix = source ? source.id + KEY_SEPARATOR : '';
  return prefix && flat.startsWith(prefix) ? flat.slice(prefix.length) : flat;
}

/** Les clés d'une maquette ajoutée : telles quelles, ou `<id>|<clé>` quand une maquette déjà ouverte a la même. */
export function flatKeys(existing: Iterable<string>, keys: readonly string[], id: string): string[] {
  const taken = new Set(existing);
  return keys.map((key) => (taken.has(key) ? `${id}${KEY_SEPARATOR}${key}` : key));
}

/** Des métadonnées dont les éléments sont désignés par les clés de la session (`keyMap` : clé du fichier → clé de la session). */
export function rekeyMetadata(metadata: Metadata, keyMap: ReadonlyMap<string, string>): Metadata {
  const elements = new Map<string, MetadataEntry>();
  for (const [key, entry] of metadata.elements) {
    const flat = keyMap.get(key);
    if (flat !== undefined) elements.set(flat, entry);
  }
  return { ...metadata, elements };
}

/** La boîte (repère du viewer) des éléments d'une maquette. */
export function sourceBox(model: Model, source: ModelSourceInfo, target = new Box3()): Box3 {
  return model.boxOf(Array.from({ length: source.count }, (_, i) => source.start + i), target);
}

/**
 * Deux maquettes qui devraient se superposer et ne le font pas : la distance entre leurs boîtes, quand elle dépasse la plus
 * grande des deux (repères différents, point de base déplacé…) ; null si elles se touchent ou sont proches.
 */
export function framesApart(a: Box3, b: Box3): number | null {
  if (a.isEmpty() || b.isEmpty()) return null;
  const gap = Math.max(0, a.min.x - b.max.x, b.min.x - a.max.x) ** 2 + Math.max(0, a.min.y - b.max.y, b.min.y - a.max.y) ** 2 + Math.max(0, a.min.z - b.max.z, b.min.z - a.max.z) ** 2;
  const distance = Math.sqrt(gap);
  const size = Math.max(a.getSize(new Vector3()).length(), b.getSize(new Vector3()).length());
  return distance > size ? distance : null;
}

/** La phrase qui dit que deux maquettes ne se superposent pas (voir `framesApart`), ou rien. */
export function framesNotice(apart: number | null, name: string): string {
  if (apart === null) return '';
  return `« ${name} » est à ${integer.format(Math.round(apart))} m de la maquette ouverte : les deux fichiers n’ont peut-être pas le même repère (point de base déplacé). Le recalage n’est pas encore disponible.`;
}

/** Le budget dépassé : l'ajout refusé, avec les chiffres. */
export class FederationError extends Error {}

export interface SourceInput {
  name: string;
  kind: ModelSourceInfo['kind'];
  role?: ModelSourceInfo['role'];
  geometry: ModelSource | RawModel;
}

export interface AddedSource {
  change: TailChange;
  source: ModelSourceInfo;
  /** Clé du fichier → clé de la session, pour chaque élément de la maquette ajoutée. */
  keyMap: Map<string, string>;
  /** Clés prises par une maquette précédente, donc préfixées. */
  prefixed: number;
  /** Distance à la maquette ouverte quand les deux ne se superposent pas (voir `framesApart`). */
  apart: number | null;
}

export interface FederationContext {
  model: Model;
  splits: SplitSet;
  selectColor: IUniform<Color>;
  /** Ce que les pièces reprennent de leur original, pour les remettre après l'ajout (voir `SplitSet.reshape`). */
  original: OriginalOf;
  /** Le nom et la nature de la maquette déjà ouverte, si c'est la première fois qu'on en ajoute une. */
  first: { name: string; kind: ModelSourceInfo['kind'] };
  /** Triangles au plus pour toutes les maquettes réunies (voir `deviceTriangleBudget`). */
  maxTriangles: number;
}

/** La maquette déjà ouverte, décrite comme la première d'une session (tout ce qui précède les pièces). */
function firstSource(model: Model, splits: SplitSet, first: FederationContext['first']): ModelSourceInfo {
  const { element, chunk } = splits.tailStart;
  let triangles = 0;
  for (let c = 0; c < chunk; c++) triangles += model.chunks[c].index.length / 3;
  return { id: 'm1', name: first.name, kind: first.kind, role: 'model', start: 0, count: element, chunkStart: 0, chunkCount: chunk, triangles, offset: model.offset.toArray() };
}

/**
 * Ajoute une maquette au modèle ouvert : collecte, refus si le budget de triangles serait dépassé (rien n'a changé alors),
 * puis cuisson à la suite des éléments du fichier, les pièces remises après. Rend le changement de numéros, à reporter sur
 * les propriétés (`App.changeParts`, avec les métadonnées de la maquette ajoutée passées par `rekeyMetadata`).
 */
export function addSource(context: FederationContext, input: SourceInput): AddedSource {
  const { model, splits } = context;
  const { collected, triangles } = collect(input.geometry, model.offset);
  if (collected.pieces.length === 0) throw new FederationError(`« ${input.name} » ne contient aucune géométrie triangulée.`);
  const total = model.triangleCount + triangles;
  if (total > context.maxTriangles) {
    throw new FederationError(`« ${input.name} » n’est pas ajouté : ses ${millions(triangles)} de triangles, avec les ${millions(model.triangleCount)} déjà affichés, dépasseraient le budget de cet appareil (${millions(context.maxTriangles)}).`);
  }
  const first = model.sources.length === 0;
  if (first) model.sources.push(firstSource(model, splits, context.first));
  const id = `m${Math.max(...model.sources.map((source) => Number(source.id.slice(1)) || 0)) + 1}`;
  const keys = flatKeys(model.keys, collected.keys, id);
  // Deux maquettes de même nom (le même fichier ajouté deux fois) : la seconde devient « nom (2) », pour les distinguer.
  let name = input.name;
  for (let n = 2; model.sources.some((source) => source.name === name); n++) name = `${input.name} (${n})`;
  const before = model.box.clone();
  let record: ModelSourceInfo | null = null;
  // Un échec en cours d'ajout (mémoire) : `reshape` a remis le modèle et ses pièces comme avant ; la session aussi.
  const reshape = (edit: () => { cut: number; inserted: number }) => {
    try {
      return splits.reshape(edit, context.original);
    } catch (error) {
      if (first) model.sources.length = 0;
      throw error;
    }
  };
  const change = reshape(() => {
    const cut = model.count, chunkStart = model.chunks.length;
    new ModelBuilder(context.selectColor, model).bake(collected);
    for (let i = 0; i < keys.length; i++) model.keys[cut + i] = keys[i];
    record = {
      id, name, kind: input.kind, role: input.role ?? 'model', start: cut, count: keys.length,
      chunkStart, chunkCount: model.chunks.length - chunkStart, triangles, offset: collected.offset.toArray(),
    };
    return { cut, inserted: keys.length };
  });
  const source = record as ModelSourceInfo | null;
  if (!source) throw new Error('Maquette ajoutée incohérente.');
  model.sources.push(source);
  const keyMap = new Map(collected.keys.map((key, i) => [key, keys[i]]));
  const prefixed = keys.filter((key, i) => key !== collected.keys[i]).length;
  return { change, source, keyMap, prefixed, apart: framesApart(before, sourceBox(model, source)) };
}

/**
 * Retire la dernière maquette ajoutée (ses éléments et ses lots ; les pièces de la première sont remises). Rend le
 * changement de numéros. Revenue à une seule maquette, la session n'en décrit plus aucune (`Model.sources` vide).
 */
export function removeLastSource(model: Model, splits: SplitSet, original: OriginalOf): TailChange {
  const last = model.sources[model.sources.length - 1];
  if (!last || model.sources.length < 2) throw new FederationError('Il n’y a pas de maquette ajoutée à retirer.');
  const change = splits.reshape(() => {
    model.truncate(last.start, last.chunkStart, true);
    return { cut: last.start, inserted: 0 };
  }, original);
  model.sources.pop();
  if (model.sources.length === 1) model.sources.length = 0;
  return change;
}

/**
 * Un document du contrat (« JSON ↓ » ou « Modifications ↓ ») de la session, découpé par maquette : à chacune ses éléments,
 * sous leurs clés d'origine et sans `Modèle`. Les sections de la session (vues, découpages, zones, conflits…) vont à la
 * première ; `source` (modifications) nomme le fichier de chaque maquette.
 */
export function documentsBySource(document: Record<string, unknown>, model: Model): { source: ModelSourceInfo; document: Record<string, unknown> }[] {
  const sources = model.sources;
  const owner = new Map<string, number>();
  for (let i = 0; i < model.count; i++) owner.set(model.keys[i], sourceIndexOf(model, i));
  const elements = isRecord(document.elements) ? document.elements : {};
  const { elements: _elements, version, propertiesMode, readOnly, source: fileSource, ...sections } = document;
  void _elements;
  return sources.map((source, s) => {
    const own: Record<string, unknown> = {};
    for (const [flat, entry] of Object.entries(elements)) {
      if ((owner.get(flat) ?? 0) !== s) continue;
      let value = entry;
      if (isRecord(entry) && isRecord(entry.properties) && Object.hasOwn(entry.properties, MODEL_PROPERTY)) {
        const { [MODEL_PROPERTY]: _model, ...properties } = entry.properties;
        void _model;
        value = { ...entry, properties };
      }
      Object.defineProperty(own, sourceKey(flat, source), { value, enumerable: true, configurable: true, writable: true });
    }
    const out: Record<string, unknown> = { version };
    if (isRecord(fileSource)) out.source = { name: source.name, kind: source.kind };
    if (propertiesMode !== undefined) out.propertiesMode = propertiesMode;
    const locks = Array.isArray(readOnly) ? readOnly.filter((pattern) => pattern !== MODEL_PROPERTY) : [];
    if (locks.length > 0) out.readOnly = locks;
    out.elements = own;
    return { source, document: s === 0 ? { ...out, ...sections } : out };
  });
}
