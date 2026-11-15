// La boîte de coupe, en calcul pur (sans three.js) : partagée par le moteur de coupe (engine/Sections.ts) et les points de vue
// BCF des observations (data/observations.ts), que le suivi de chantier charge sans la 3D.

type Triple = [number, number, number];

/** Une boîte de coupe : coins avant rotation, et rotation autour de la verticale (degrés). */
export interface BoxCut {
  min: Triple;
  max: Triple;
  rotation: number;
}

/** Les axes de la boîte tournée de `rotation` degrés autour de Y : x → (cos, 0, −sin), y, z → (sin, 0, cos). */
export function boxAxes(rotation: number): Triple[] {
  const angle = (rotation * Math.PI) / 180, c = Math.cos(angle), s = Math.sin(angle);
  return [[c, 0, -s], [0, 1, 0], [s, 0, c]];
}

/** Les six faces d'une boîte (−x, +x, −y, +y, −z, +z de la boîte) : centre et normale vers l'extérieur, dans le repère de la boîte posée. */
export function boxFaces(box: BoxCut): { centre: Triple; normal: Triple }[] {
  const centre = [0, 1, 2].map((i) => (box.min[i] + box.max[i]) / 2);
  const axes = boxAxes(box.rotation);
  return [0, 1, 2, 3, 4, 5].map((face) => {
    const axis = face >> 1, sign = face & 1 ? 1 : -1, half = (box.max[axis] - box.min[axis]) / 2;
    const normal = axes[axis].map((x) => x * sign) as Triple;
    return { centre: centre.map((x, i) => x + normal[i] * half) as Triple, normal };
  });
}
