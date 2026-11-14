// Export d'une proposition pour le viewer : un GLB (un nœud par volume, `extras.id` et propriétés, couleur de l'usage
// en couleur de sommet) et son JSON de métadonnées (docs/contrat-metadonnees.md) qui porte le géoréférencement :
// l'origine du site est l'origine du projet, le nord du projet est le nord vrai, l'altitude celle de l'origine. Le viewer
// pose ainsi la proposition au bon endroit sur sa carte (déposer les deux fichiers ensemble).

import { ARRAY_BUFFER, FLOAT, GlbBuffer, encodeGlb } from '../engine/glbFile.ts';
import { georeferenceToJson } from '../geo/georeference.ts';
import { polygonArea } from './metrics.ts';
import { volumeMesh } from './massing.ts';
import { useOf, type Proposal, type Study, type Volume } from './study.ts';

const round = (value: number) => Math.round(value * 100) / 100;

/** Couleur CSS « #rrggbb » → composantes linéaires (le glTF veut des couleurs de sommet linéaires). */
function linearColor(css: string): [number, number, number] {
  const value = parseInt(css.replace('#', ''), 16) || 0;
  return [16, 8, 0].map((shift) => {
    const c = ((value >> shift) & 255) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}

function properties(study: Study, proposal: Proposal, volume: Volume): Record<string, unknown> {
  const useName = (id: string) => study.settings.uses.find((use) => use.id === id)?.name ?? id;
  const area = polygonArea(volume.footprint);
  const out: Record<string, unknown> = {
    Proposition: proposal.name,
    Volume: volume.name,
    Usage: useName(volume.use),
    Niveaux: volume.floors,
    'Hauteur d’étage (m)': round(volume.floorHeight),
    'Niveau de base (m)': round(volume.baseLevel),
    'Hauteur (m)': round(volume.floors * volume.floorHeight),
    'Emprise (m²)': round(area),
    'Surface de plancher (m²)': round(area * volume.floors),
  };
  if (volume.floorUses?.some(Boolean)) out['Usages par niveau'] = Array.from({ length: volume.floors }, (_, floor) => useName(useOf(volume, floor))).join(', ');
  return { 'Étude de site': out };
}

export function proposalGlb(study: Study, proposal: Proposal): ArrayBuffer {
  const buffer = new GlbBuffer();
  const colorOf = new Map(study.settings.uses.map((use) => [use.id, linearColor(use.color)]));
  const meshes: Record<string, unknown>[] = [], nodes: Record<string, unknown>[] = [];
  for (const volume of proposal.volumes) {
    const { positions, normals, segments } = volumeMesh(volume);
    const node: Record<string, unknown> = { name: volume.name, extras: { ...properties(study, proposal, volume), id: volume.id } };
    const count = positions.length / 3;
    if (count > 0) {
      const colors = new Float32Array(count * 4);
      for (const segment of segments) {
        const [r, g, b] = colorOf.get(segment.use) ?? [0.5, 0.5, 0.5];
        for (let v = segment.start; v < segment.start + segment.count; v++) colors.set([r, g, b, 1], v * 4);
      }
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i++) {
        min[i % 3] = Math.min(min[i % 3], positions[i]);
        max[i % 3] = Math.max(max[i % 3], positions[i]);
      }
      meshes.push({ name: volume.name, primitives: [{ attributes: {
        POSITION: buffer.add(positions, ARRAY_BUFFER, { componentType: FLOAT, count, type: 'VEC3', min, max }),
        NORMAL: buffer.add(normals, ARRAY_BUFFER, { componentType: FLOAT, count, type: 'VEC3' }),
        COLOR_0: buffer.add(colors, ARRAY_BUFFER, { componentType: FLOAT, count, type: 'VEC4' }),
      }, material: 0 }] });
      node.mesh = meshes.length - 1;
    }
    nodes.push(node);
  }
  const { byteLength, accessors, bufferViews } = buffer;
  return encodeGlb({
    asset: { version: '2.0', generator: 'viewer-bim étude de site' },
    scene: 0,
    scenes: [nodes.length > 0 ? { nodes: nodes.map((_, i) => i) } : {}],
    ...(nodes.length > 0 ? { nodes } : {}),
    ...(byteLength > 0 ? {
      meshes, accessors, bufferViews, buffers: [{ byteLength }],
      materials: [{ name: 'Volumes', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
    } : {}),
  }, buffer.parts);
}

/** Le JSON de métadonnées qui accompagne le GLB : propriétés de chaque volume et géoréférencement du site. */
export function proposalMetadata(study: Study, proposal: Proposal): Record<string, unknown> {
  const { latitude, longitude, altitude } = study.site.origin;
  return {
    version: 1,
    georeference: georeferenceToJson({ latitude, longitude, elevation: altitude, origin: [0, 0, 0], trueNorth: [0, 1], source: 'Étude de site' }),
    elements: Object.fromEntries(proposal.volumes.map((volume) => [volume.id, { label: volume.name, properties: properties(study, proposal, volume) }])),
  };
}
