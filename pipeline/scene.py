"""Scène convertie : maillages, matériaux et éléments, indépendants du format de sortie.

Ce module ne dépend ni d'IfcOpenShell ni du convertisseur : l'écriture USD (`usd_writer.py`) le
charge seule, sans le moteur IFC, pour emballer un modèle qui ne vient pas d'un IFC.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

import numpy as np


def _srgb_to_linear(value: float) -> float:
    value = min(1.0, max(0.0, value))
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def _is_closed(positions: np.ndarray, triangles: np.ndarray) -> bool:
    """Vrai si les triangles forment une enveloppe fermée, orientée de façon cohérente.

    Les sommets de même position sont soudés, puis chaque arête doit être parcourue autant
    de fois dans un sens que dans l'autre (même règle que dans le viewer).
    """
    if len(triangles) == 0:
        return False
    low = positions.min(axis=0)
    extent = float((positions.max(axis=0) - low).max())
    scale = 100000.0 / extent if extent > 0 else 0.0
    grid = np.rint((positions - low) * scale).astype(np.int64)
    keys = (grid[:, 0] << 34) + (grid[:, 1] << 17) + grid[:, 2]
    unique, ids = np.unique(keys, return_inverse=True)
    corners = ids[triangles]
    valid = (corners[:, 0] != corners[:, 1]) & (corners[:, 1] != corners[:, 2]) & (corners[:, 0] != corners[:, 2])
    corners = corners[valid]
    if len(corners) == 0:
        return False
    start = corners.ravel()
    end = corners[:, [1, 2, 0]].ravel()
    edges = np.minimum(start, end) * np.int64(len(unique)) + np.maximum(start, end)
    signs = np.where(start < end, 1, -1)
    order = np.argsort(edges, kind="stable")
    edges = edges[order]
    boundaries = np.flatnonzero(np.r_[True, edges[1:] != edges[:-1]])
    return bool(np.all(np.add.reduceat(signs[order], boundaries) == 0))


@dataclass
class Primitive:
    """Un paquet de triangles d'un même matériau."""

    positions: np.ndarray  # float32, N × 3, en mètres, dans le repère de l'élément
    normals: np.ndarray | None  # float32, N × 3
    indices: np.ndarray  # int32, 3 par triangle
    material: int


@dataclass
class MeshData:
    primitives: list[Primitive]
    triangles: int


@dataclass
class MaterialData:
    name: str
    rgba: tuple[float, float, float, float]  # couleur linéaire et opacité
    double_sided: bool


@dataclass
class ElementData:
    guid: str
    name: str | None
    # Maillage et matrice (16 valeurs, colonnes d'abord, comme glTF) de chaque forme de l'élément.
    placements: list[tuple[int, tuple[float, ...]]]


class Scene:
    """Géométrie convertie, indépendante du format de sortie (GLB ou USD)."""

    def __init__(self) -> None:
        self.meshes: list[MeshData] = []
        self.materials: list[MaterialData] = []
        self.material_index: dict[tuple, int] = {}
        self.elements: list[ElementData] = []

    def material(self, name: str, rgba: tuple[float, float, float, float], double_sided: bool) -> int:
        key = (name, tuple(round(c, 4) for c in rgba), double_sided)
        index = self.material_index.get(key)
        if index is None:
            self.materials.append(MaterialData(name, key[1], double_sided))  # type: ignore[arg-type]
            index = self.material_index[key] = len(self.materials) - 1
        return index

    def mesh(self, geometry: Any) -> tuple[int, int] | None:
        """Ajoute la géométrie d'une forme IfcOpenShell. Renvoie (indice du maillage, triangles)."""
        positions = np.frombuffer(geometry.verts_buffer, dtype="d").reshape(-1, 3)
        triangles = np.frombuffer(geometry.faces_buffer, dtype="i").reshape(-1, 3)
        if len(positions) == 0 or len(triangles) == 0 or not np.isfinite(positions).all():
            return None
        normals = np.frombuffer(geometry.normals_buffer, dtype="d").reshape(-1, 3)
        has_normals = len(normals) == len(positions) and np.isfinite(normals).all()
        material_ids = np.frombuffer(geometry.material_ids_buffer, dtype="i")
        if len(material_ids) != len(triangles):
            material_ids = np.zeros(len(triangles), dtype="i")

        # Une surface ouverte (feuille, terrain, coque mal orientée) est affichée sur ses deux
        # faces ; un solide fermé garde une seule face, ce qui permet de remplir les coupes.
        double_sided = not _is_closed(positions, triangles)
        styles = list(geometry.materials)
        primitives = []
        for material_id in np.unique(material_ids):
            selected = triangles[material_ids == material_id]
            used, remapped = np.unique(selected, return_inverse=True)
            style = styles[int(material_id)] if 0 <= material_id < len(styles) else None
            if style is not None:
                diffuse = style.diffuse
                transparency = style.transparency
                alpha = 1.0 - transparency if math.isfinite(transparency) else 1.0
                # Les couleurs IFC sont saisies pour l'écran (sRGB) ; glTF et USD les attendent en linéaire.
                rgba = (_srgb_to_linear(diffuse.r()), _srgb_to_linear(diffuse.g()), _srgb_to_linear(diffuse.b()), min(1.0, max(0.0, alpha)))
                name = style.name
            else:
                rgba, name = (0.45, 0.45, 0.45, 1.0), "Défaut"
            primitives.append(
                Primitive(
                    positions=positions[used].astype(np.float32),
                    normals=normals[used].astype(np.float32) if has_normals else None,
                    indices=remapped.reshape(-1).astype(np.int32),
                    material=self.material(name, rgba, double_sided),
                )
            )
        self.meshes.append(MeshData(primitives, len(triangles)))
        return len(self.meshes) - 1, len(triangles)

    def element(self, guid: str, name: str | None, placements: list[tuple[int, tuple[float, ...]]]) -> None:
        self.elements.append(ElementData(guid, name, placements))
