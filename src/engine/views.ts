// Vues standard de la vue 2D : d'où la caméra regarde la maquette, et quel côté est en haut.
// Repère du viewer (glTF) : X vers l'est du projet, Y vers le haut, −Z vers le nord du projet.

import { Vector3 } from 'three';

export type StandardView = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export const VIEW_ORDER: readonly StandardView[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];

export const STANDARD_VIEWS: Record<StandardView, { label: string; title: string; direction: Vector3; up: Vector3 }> = {
  front: { label: 'Face', title: 'Élévation sud : la maquette vue de face', direction: new Vector3(0, 0, 1), up: new Vector3(0, 1, 0) },
  back: { label: 'Arrière', title: 'Élévation nord : la maquette vue de l’arrière', direction: new Vector3(0, 0, -1), up: new Vector3(0, 1, 0) },
  left: { label: 'Gauche', title: 'Élévation ouest : la maquette vue de la gauche', direction: new Vector3(-1, 0, 0), up: new Vector3(0, 1, 0) },
  right: { label: 'Droite', title: 'Élévation est : la maquette vue de la droite', direction: new Vector3(1, 0, 0), up: new Vector3(0, 1, 0) },
  top: { label: 'Haut', title: 'Plan : la maquette vue du dessus, nord en haut', direction: new Vector3(0, 1, 0), up: new Vector3(0, 0, -1) },
  bottom: { label: 'Bas', title: 'La maquette vue du dessous, nord en haut', direction: new Vector3(0, -1, 0), up: new Vector3(0, 0, -1) },
};
