import { Color } from 'three';
import { buildModel } from '../src/engine/buildModel.ts';
import { loadModelFiles } from '../src/engine/loadModel.ts';
import type { Model } from '../src/engine/Model.ts';

export interface TestMesh {
  positions: Float32Array;
  indices?: Uint32Array;
}

/** Un triangle non indexé et sans normales. */
export const TRIANGLE: TestMesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]) };

/** Cube unité à 8 sommets partagés, sans normales, faces orientées vers l'extérieur. */
export const CUBE: TestMesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]),
  indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]),
};

/** Le glTF en cours de fabrication, modifiable par un test avant son empaquetage. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GltfDraft = Record<string, any>;

function pad(buffer: Buffer, fill = 0): Buffer {
  return Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4, fill)]);
}

/** Fabrique un GLB minimal (un seul maillage, réutilisable par plusieurs nœuds) et le charge comme le viewer. */
export async function buildFromNodes(nodes: object[], roots: number[], mesh: TestMesh = TRIANGLE, patch?: (gltf: GltfDraft) => void): Promise<Model> {
  return (await loadTestModel(nodes, roots, mesh, patch)).model;
}

export async function loadTestModel(
  nodes: object[],
  roots: number[],
  mesh: TestMesh = TRIANGLE,
  patch?: (gltf: GltfDraft) => void,
): Promise<{ model: Model; warnings: string[] }> {
  const positions = pad(Buffer.from(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  const indices = mesh.indices ? pad(Buffer.from(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength)) : null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], mesh.positions[i]);
    max[i % 3] = Math.max(max[i % 3], mesh.positions[i]);
  }
  const bin = indices ? Buffer.concat([positions, indices]) : positions;
  const gltf: GltfDraft = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: roots }],
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, ...(indices ? { indices: 1 } : {}) }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: mesh.positions.length / 3, type: 'VEC3', min, max },
      ...(mesh.indices ? [{ bufferView: 1, componentType: 5125, count: mesh.indices.length, type: 'SCALAR' }] : []),
    ],
    bufferViews: [
      { buffer: 0, byteLength: mesh.positions.byteLength },
      ...(mesh.indices ? [{ buffer: 0, byteOffset: positions.length, byteLength: mesh.indices.byteLength }] : []),
    ],
    buffers: [{ byteLength: bin.length }],
  };
  patch?.(gltf);
  const json = pad(Buffer.from(JSON.stringify(gltf), 'utf8'), 0x20);
  const header = Buffer.alloc(20);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + json.length + bin.length, 8);
  header.writeUInt32LE(json.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  const glb = Buffer.concat([header, json, binHeader, bin]);
  // Même chemin que l'application : lecture du fichier, préparation du glTF, puis fusion.
  const file = new File([glb], 'test.glb');
  const { gltf: parsed, warnings } = await loadModelFiles({ file, path: file.name }, []);
  return { model: buildModel(parsed, { value: new Color() }), warnings };
}
