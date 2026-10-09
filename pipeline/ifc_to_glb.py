"""Convertit un fichier IFC en GLB (géométrie) + JSON (métadonnées) pour le Viewer BIM.

Le lien entre les deux fichiers est l'identifiant IFC de chaque élément (GlobalId) :
il est écrit dans `extras.id` du nœud glTF et sert de clé dans le JSON. Le format produit est
décrit dans docs/contrat-metadonnees.md.

Utilisation en ligne de commande :

    python ifc_to_glb.py maquette.ifc                 # écrit maquette.glb et maquette.json
    python ifc_to_glb.py maquette.ifc -o sortie/      # dans un autre dossier
    python ifc_to_glb.py maquette.ifc --espaces       # exporte aussi les IfcSpace
    python ifc_to_glb.py maquette.ifc --classes IfcWall,IfcSlab   # seulement ces classes
    python ifc_to_glb.py maquette.ifc --format usd    # écrit maquette.usdz (voir usd_writer.py)

Le même module est exécuté dans le navigateur (Pyodide) quand on dépose un IFC dans le viewer.
"""

from __future__ import annotations

import argparse
import json
import math
import struct
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

import numpy as np

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.util.element as element_util
import ifcopenshell.util.placement as placement_util
import ifcopenshell.util.unit as unit_util

CONTRACT_VERSION = 1

# Propriétés que le viewer ne doit pas laisser modifier : elles viennent de relations IFC
# (classe, type, structure spatiale, matériaux) ou de calculs sur la géométrie (quantités).
READ_ONLY = ["Classe IFC", "Type", "Type prédéfini", "Site", "Bâtiment", "Niveau", "Local", "Matériaux", "Qto_*"]

# IFC est en Z vers le haut, glTF en Y vers le haut : (x, y, z) devient (x, z, -y).
Z_UP_TO_Y_UP = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]
IDENTITY = (1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0)

# Noms des niveaux de la structure spatiale, tels qu'ils apparaîtront dans le viewer.
SPATIAL_LABELS = {
    "IfcSite": "Site",
    "IfcBuilding": "Bâtiment",
    "IfcBuildingStorey": "Niveau",
    "IfcSpace": "Local",
}

# Représentations faites de lignes ou de points : elles ne donnent aucun triangle.
LINEWORK_TYPES = {"Curve", "Curve2D", "Curve3D", "GeometricCurveSet", "Annotation2D", "Point", "PointCloud", "Text"}

ARRAY_BUFFER = 34962
ELEMENT_ARRAY_BUFFER = 34963


@dataclass
class Conversion:
    """Résultat d'une conversion : la scène, prête à être écrite en GLB ou en USD, et les métadonnées."""

    scene: "Scene"
    metadata: dict[str, Any]
    report: dict[str, Any] = field(default_factory=dict)
    generator: str = "viewer-bim ifc_to_glb"
    _glb: bytes | None = field(default=None, repr=False)

    @property
    def glb(self) -> bytes:
        if self._glb is None:
            self._glb = write_glb(self.scene, self.generator)
        return self._glb

    def usda(self) -> str:
        from usd_writer import write_usda

        return write_usda(self.scene, self.metadata, self.generator)

    def usdz(self) -> bytes:
        from usd_writer import write_usdz

        return write_usdz(self.usda())

    def metadata_json(self) -> str:
        return json.dumps(self.metadata, ensure_ascii=False, separators=(",", ":"))


# ------------------------------------------------------------------ métadonnées


def _jsonable(value: Any) -> Any:
    """Ramène une valeur de propriété IFC à un type que le JSON sait écrire."""
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items() if key != "id"}
    return str(value)


def _spatial_path(element: Any) -> dict[str, str]:
    """Site, bâtiment, niveau et local qui contiennent l'élément."""
    path: dict[str, str] = {}
    container = element_util.get_container(element)
    seen = 0
    while container is not None and seen < 32:
        label = SPATIAL_LABELS.get(container.is_a())
        if label and label not in path:
            path[label] = container.Name or container.LongName or container.GlobalId
        container = element_util.get_aggregate(container)
        seen += 1
    return path


def describe(element: Any) -> dict[str, Any]:
    """Entrée du JSON de métadonnées pour un élément : libellé et propriétés."""
    ifc_class = element.is_a()
    properties: dict[str, Any] = {"Classe IFC": ifc_class}

    if element.Name:
        properties["Nom"] = element.Name
    element_type = element_util.get_type(element)
    if element_type is not None:
        properties["Type"] = element_type.Name or element_type.is_a()
    predefined = element_util.get_predefined_type(element)
    if predefined and predefined not in ("NOTDEFINED", "USERDEFINED"):
        properties["Type prédéfini"] = predefined
    for attribute, label in (("Description", "Description"), ("ObjectType", "Type d'objet"), ("Tag", "Repère")):
        value = getattr(element, attribute, None)
        if value:
            properties[label] = value

    # La structure spatiale devient de simples propriétés : le viewer s'en sert pour
    # construire l'arborescence (Site, puis Bâtiment, puis Niveau…).
    spatial = _spatial_path(element)
    for label in ("Site", "Bâtiment", "Niveau", "Local"):
        if label in spatial:
            properties[label] = spatial[label]

    materials = [material.Name for material in element_util.get_materials(element) if getattr(material, "Name", None)]
    if materials:
        properties["Matériaux"] = ", ".join(dict.fromkeys(materials))

    # Jeux de propriétés et de quantités (ceux du type compris) : un jeu = une catégorie.
    for name, values in element_util.get_psets(element).items():
        content = _jsonable(values)
        if content:
            properties[name] = content

    label = element.Name or f"{ifc_class} {getattr(element, 'Tag', None) or element.GlobalId}"
    return {"label": label, "properties": properties}


def _has_volume(product: Any) -> bool:
    """Faux pour les axes de trame, les annotations et tout ce qui n'est dessiné qu'en lignes."""
    if product.is_a("IfcGrid") or product.is_a("IfcAnnotation"):
        return False
    representations = product.Representation.Representations or ()
    return any((representation.RepresentationType or "") not in LINEWORK_TYPES for representation in representations)


# -------------------------------------------------------------------- géométrie


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


class _GlbWriter:
    """Assemble le glTF binaire : tampon de géométrie, maillages, matériaux, nœuds."""

    def __init__(self) -> None:
        self.chunks: list[bytes] = []
        self.byte_length = 0
        self.buffer_views: list[dict[str, Any]] = []
        self.accessors: list[dict[str, Any]] = []

    def _view(self, data: np.ndarray, target: int) -> int:
        raw = data.tobytes()
        self.buffer_views.append({"buffer": 0, "byteOffset": self.byte_length, "byteLength": len(raw), "target": target})
        padding = (-len(raw)) % 4
        self.chunks.append(raw + b"\x00" * padding)
        self.byte_length += len(raw) + padding
        return len(self.buffer_views) - 1

    def _accessor(self, data: np.ndarray, target: int, component: int, kind: str, bounds: bool = False) -> int:
        accessor: dict[str, Any] = {"bufferView": self._view(data, target), "componentType": component, "count": len(data), "type": kind}
        if bounds:
            accessor["min"] = [float(v) for v in data.min(axis=0)]
            accessor["max"] = [float(v) for v in data.max(axis=0)]
        self.accessors.append(accessor)
        return len(self.accessors) - 1

    def write(self, scene: Scene, generator: str) -> bytes:
        materials: list[dict[str, Any]] = []
        for material in scene.materials:
            entry: dict[str, Any] = {
                "name": material.name,
                "pbrMetallicRoughness": {"baseColorFactor": list(material.rgba), "metallicFactor": 0, "roughnessFactor": 0.9},
            }
            if material.rgba[3] < 1:
                entry["alphaMode"] = "BLEND"
            if material.double_sided:
                entry["doubleSided"] = True
            materials.append(entry)

        meshes: list[dict[str, Any]] = []
        for mesh in scene.meshes:
            primitives = []
            for primitive in mesh.primitives:
                attributes = {"POSITION": self._accessor(primitive.positions, ARRAY_BUFFER, 5126, "VEC3", bounds=True)}
                if primitive.normals is not None:
                    attributes["NORMAL"] = self._accessor(primitive.normals, ARRAY_BUFFER, 5126, "VEC3")
                if len(primitive.positions) <= 65535:
                    indices = self._accessor(primitive.indices.astype(np.uint16), ELEMENT_ARRAY_BUFFER, 5123, "SCALAR")
                else:
                    indices = self._accessor(primitive.indices.astype(np.uint32), ELEMENT_ARRAY_BUFFER, 5125, "SCALAR")
                primitives.append({"attributes": attributes, "indices": indices, "material": primitive.material})
            meshes.append({"primitives": primitives})

        # Le nœud 0 est la racine : elle passe de Z vers le haut (IFC) à Y vers le haut (glTF).
        nodes: list[dict[str, Any]] = [{"name": "IFC", "matrix": Z_UP_TO_Y_UP, "children": []}]
        for element in scene.elements:
            # `extras.id` porte le GlobalId : c'est la clé du JSON de métadonnées.
            node: dict[str, Any] = {"extras": {"id": element.guid}}
            if element.name:
                node["name"] = element.name
            if len(element.placements) == 1:
                mesh_index, matrix = element.placements[0]
                node["mesh"] = mesh_index
                if matrix != IDENTITY:
                    node["matrix"] = list(matrix)
            else:
                # Plusieurs formes pour un même élément : des nœuds enfants sans identifiant,
                # que le viewer rattache à l'élément parent.
                node["children"] = []
                for mesh_index, matrix in element.placements:
                    child: dict[str, Any] = {"mesh": mesh_index}
                    if matrix != IDENTITY:
                        child["matrix"] = list(matrix)
                    nodes.append(child)
                    node["children"].append(len(nodes) - 1)
            nodes.append(node)
            nodes[0]["children"].append(len(nodes) - 1)

        gltf: dict[str, Any] = {"asset": {"version": "2.0", "generator": generator}, "scene": 0, "scenes": [{"nodes": [0]}], "nodes": nodes}
        if meshes:
            gltf.update(meshes=meshes, materials=materials, accessors=self.accessors, bufferViews=self.buffer_views, buffers=[{"byteLength": self.byte_length}])
        document = json.dumps(gltf, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        document += b" " * ((-len(document)) % 4)
        binary = b"".join(self.chunks)
        parts = [struct.pack("<II", len(document), 0x4E4F534A), document]
        if binary:
            parts += [struct.pack("<II", len(binary), 0x004E4942), binary]
        body = b"".join(parts)
        return struct.pack("<III", 0x46546C67, 2, 12 + len(body)) + body


def write_glb(scene: Scene, generator: str) -> bytes:
    return _GlbWriter().write(scene, generator)


# ------------------------------------------------------------------- conversion


def _degrees(parts: Any) -> float | None:
    """Latitude ou longitude IFC : (degrés, minutes, secondes, millionièmes de seconde)."""
    if not parts or len(parts) < 3:
        return None
    values = [float(v) for v in parts]
    sign = -1.0 if values[0] < 0 or str(parts[0]).startswith("-") else 1.0
    micro = abs(values[3]) if len(values) > 3 else 0.0
    return sign * (abs(values[0]) + abs(values[1]) / 60 + (abs(values[2]) + micro / 1e6) / 3600)


def georeference(model: Any) -> dict[str, Any] | None:
    """Position du site sur Terre, d'après l'IFC, ou None s'il ne la donne pas.

    Latitude/longitude et altitude viennent d'IfcSite ; l'origine est le placement du site dans
    le repère du projet (mètres) ; le nord vrai vient du contexte géométrique. En IFC4, une
    IfcMapConversion (coordonnées projetées) est recopiée telle quelle, à titre indicatif.
    """
    scale = unit_util.calculate_unit_scale(model)
    for site in model.by_type("IfcSite"):
        latitude = _degrees(site.RefLatitude)
        longitude = _degrees(site.RefLongitude)
        if latitude is None or longitude is None:
            continue
        origin = [0.0, 0.0, 0.0]
        if site.ObjectPlacement is not None:
            matrix = placement_util.get_local_placement(site.ObjectPlacement)
            origin = [round(float(v) * scale, 6) for v in matrix[:3, 3]]
        true_north = [0.0, 1.0]
        for context in model.by_type("IfcGeometricRepresentationContext"):
            direction = getattr(context, "TrueNorth", None)
            if direction is not None and context.is_a() == "IfcGeometricRepresentationContext":
                ratios = [float(v) for v in direction.DirectionRatios[:2]]
                length = (ratios[0] ** 2 + ratios[1] ** 2) ** 0.5
                if length > 0:
                    true_north = [round(ratios[0] / length, 9), round(ratios[1] / length, 9)]
                break
        result: dict[str, Any] = {
            "latitude": round(latitude, 9),
            "longitude": round(longitude, 9),
            "elevation": round(float(site.RefElevation or 0.0) * scale, 6),
            "origin": origin,
            "trueNorth": true_north,
            "source": "IfcSite",
        }
        if model.schema != "IFC2X3":
            for conversion in model.by_type("IfcMapConversion"):
                crs = conversion.TargetCRS
                result["projected"] = {
                    "crs": getattr(crs, "Name", None),
                    "eastings": float(conversion.Eastings),
                    "northings": float(conversion.Northings),
                    "height": float(conversion.OrthogonalHeight),
                    "xAxis": [float(conversion.XAxisAbscissa or 1.0), float(conversion.XAxisOrdinate or 0.0)],
                    "scale": float(conversion.Scale or 1.0),
                }
                break
        return result
    return None


def convert(
    model: Any,
    *,
    include_spaces: bool = False,
    classes: list[str] | None = None,
    ids: list[str] | None = None,
    shard: tuple[int, int] | None = None,
    threads: int | None = None,
    progress: Callable[[int], None] | None = None,
) -> Conversion:
    """Convertit un modèle IFC ouvert (`ifcopenshell.open`) en GLB et en métadonnées.

    `classes` et `ids` restreignent la conversion à certaines classes IFC (sous-classes comprises)
    ou à certains GlobalId. Les éléments conservés gardent leur identifiant et leurs propriétés.
    `shard=(i, n)` ne convertit que la tranche i sur n des éléments : le viewer s'en sert pour
    répartir un IFC sur plusieurs cœurs, puis réunit les résultats.
    """
    started = time.perf_counter()
    if threads is None:
        # Pas de fils d'exécution dans le navigateur (Pyodide).
        threads = 1 if sys.platform == "emscripten" else max(1, __import__("os").cpu_count() or 1)

    settings = ifcopenshell.geom.settings()
    # Sommets non soudés : chaque face garde ses normales, les arêtes vives restent vives.
    settings.set("weld-vertices", False)
    # Matériaux nommés d'après le matériau IFC plutôt que d'après le style de surface.
    settings.set("use-material-names", True)

    # Éléments à convertir : tout produit qui porte une représentation, hors ouvertures (elles
    # sont soustraites des murs et dalles par IfcOpenShell) et, par défaut, hors locaux.
    skipped = ("IfcOpeningElement",) if include_spaces else ("IfcOpeningElement", "IfcSpace")
    candidates = [product for product in model.by_type("IfcProduct") if getattr(product, "Representation", None) is not None]
    products = [product for product in candidates if not any(product.is_a(name) for name in skipped)]
    excluded = len(candidates) - len(products)

    # Filtres facultatifs : seuls les éléments demandés sont calculés.
    if classes:
        products = [product for product in products if any(product.is_a(name) for name in classes)]
    if ids:
        wanted = set(ids)
        products = [product for product in products if product.GlobalId in wanted]
    if shard is not None:
        # Conversion répartie sur plusieurs processus : celui-ci traite une tranche des éléments.
        index, count = shard
        products = sorted(products, key=lambda product: product.id())[index::count]

    # Les axes de trame et les annotations n'ont pas de volume : ils sont laissés de côté, sans
    # être comptés comme des échecs. (Après le découpage en tranches, pour que la somme des
    # tranches donne le bon total.)
    volumes = [product for product in products if _has_volume(product)]
    linework = len(products) - len(volumes)
    products = volumes

    scene = Scene()
    mesh_by_geometry: dict[str, tuple[int, int] | None] = {}
    placements: dict[str, list[tuple[int, tuple[float, ...]]]] = {}
    names: dict[str, str | None] = {}
    triangle_count = 0
    last_progress = -1

    iterator = ifcopenshell.geom.iterator(settings, model, threads, include=products) if products else None
    if iterator is not None and iterator.initialize():
        while True:
            shape = iterator.get()
            geometry = shape.geometry
            # Les éléments qui partagent une même représentation (même type) partagent un maillage.
            if geometry.id not in mesh_by_geometry:
                mesh_by_geometry[geometry.id] = scene.mesh(geometry)
            mesh = mesh_by_geometry[geometry.id]
            if mesh is not None:
                matrix = tuple(float(v) for v in shape.transformation.matrix)
                if all(math.isfinite(v) for v in matrix):
                    placements.setdefault(shape.guid, []).append((mesh[0], matrix))
                    names.setdefault(shape.guid, shape.name or None)
                    triangle_count += mesh[1]
            if progress is not None:
                current = iterator.progress()
                if current != last_progress:
                    last_progress = current
                    progress(current)
            if not iterator.next():
                break

    elements: dict[str, Any] = {}
    for guid, shapes in placements.items():
        scene.element(guid, names[guid], shapes)
        elements[guid] = describe(model.by_guid(guid))

    # Éléments attendus mais absents : IfcOpenShell n'a pas pu calculer leur géométrie.
    failed = [
        {"id": product.GlobalId, "class": product.is_a(), "name": product.Name or ""}
        for product in products
        if product.GlobalId not in elements
    ]
    report = {
        "schema": model.schema,
        "elements": len(elements),
        "triangles": triangle_count,
        "meshes": len(scene.meshes),
        "materials": len(scene.materials),
        "excluded": excluded,
        "linework": linework,
        "without_geometry": len(failed),
        "failed": failed[:50],
        "seconds": round(time.perf_counter() - started, 2),
    }
    metadata: dict[str, Any] = {"version": CONTRACT_VERSION, "readOnly": READ_ONLY, "elements": elements}
    position = georeference(model)
    if position is not None:
        metadata["georeference"] = position
    return Conversion(
        scene=scene,
        metadata=metadata,
        report=report,
        generator=f"viewer-bim ifc_to_glb (IfcOpenShell {ifcopenshell.version})",
    )


def convert_file(path: str | Path, **options: Any) -> Conversion:
    return convert(ifcopenshell.open(str(path)), **options)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Convertit un IFC en GLB + JSON pour le Viewer BIM.")
    parser.add_argument("ifc", type=Path, help="fichier IFC à convertir")
    parser.add_argument("-o", "--output", type=Path, help="dossier de sortie (par défaut : celui de l'IFC)")
    parser.add_argument("--format", choices=["glb", "usd", "usda"], default="glb", help="format de la géométrie : glb (défaut), usd (paquet .usdz) ou usda (USD texte)")
    parser.add_argument("--espaces", action="store_true", help="exporter aussi les locaux (IfcSpace)")
    parser.add_argument("--classes", help="ne convertir que ces classes IFC, séparées par des virgules (ex. IfcWall,IfcSlab)")
    parser.add_argument("--ids", help="ne convertir que ces GlobalId, séparés par des virgules")
    parser.add_argument("--threads", type=int, help="nombre de fils d'exécution (par défaut : tous les cœurs)")
    arguments = parser.parse_args(argv)

    if not arguments.ifc.is_file():
        print(f"Fichier introuvable : {arguments.ifc}", file=sys.stderr)
        return 1
    output = arguments.output or arguments.ifc.parent
    output.mkdir(parents=True, exist_ok=True)

    def show(percent: int) -> None:
        print(f"\rGéométrie : {percent} %", end="", flush=True)

    split = lambda text: [item.strip() for item in text.split(",") if item.strip()] if text else None
    result = convert_file(
        arguments.ifc,
        include_spaces=arguments.espaces,
        classes=split(arguments.classes),
        ids=split(arguments.ids),
        threads=arguments.threads,
        progress=show,
    )
    print()
    json_path = output / f"{arguments.ifc.stem}.json"
    json_path.write_text(result.metadata_json(), encoding="utf-8")
    if arguments.format == "glb":
        glb_path = output / f"{arguments.ifc.stem}.glb"
        glb_path.write_bytes(result.glb)
    elif arguments.format == "usda":
        glb_path = output / f"{arguments.ifc.stem}.usda"
        glb_path.write_text(result.usda(), encoding="utf-8")
    else:
        glb_path = output / f"{arguments.ifc.stem}.usdz"
        glb_path.write_bytes(result.usdz())

    report = result.report
    print(f"{report['elements']} éléments, {report['triangles']} triangles, {report['meshes']} maillages, en {report['seconds']} s")
    if report["linework"]:
        print(f"{report['linework']} éléments sans volume (axes de trame, annotations) laissés de côté.")
    if report["without_geometry"]:
        print(f"{report['without_geometry']} éléments n'ont pas pu être convertis en géométrie :")
        for item in report["failed"]:
            print(f"  - {item['class']} « {item['name']} » ({item['id']})")
    print(f"→ {glb_path}\n→ {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
