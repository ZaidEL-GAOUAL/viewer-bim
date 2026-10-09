"""Écriture d'une scène convertie au format USD (OpenUSD, Pixar).

Produit un fichier `.usda` (texte) ou `.usdz` (paquet) avec la même organisation que le GLB :
un prim par élément, portant son identifiant IFC et ses métadonnées dans `customData`, et un
prototype de maillage par forme, partagé entre les éléments identiques.

    def Xform "E_2O2Fr_t4X7Zf8NOew3FLOH" (
        references = </IFC/Prototypes/Mesh_12>
        customData = {
            string id = "2O2Fr$t4X7Zf8NOew3FLOH"
            dictionary properties = { string "Classe IFC" = "IfcWall" ... }
        }
    )

Le fichier reste en Z vers le haut (`upAxis = "Z"`), comme l'IFC et comme l'usage en
construction ; le viewer fait la rotation à l'affichage.
"""

from __future__ import annotations

import json
import math
import re
import struct
import zlib
from typing import Any

import numpy as np

from ifc_to_glb import ElementData, MaterialData, MeshData, Primitive, Scene

CONTRACT_VERSION = 1
ROOT = "/IFC"
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


# ------------------------------------------------------------------- formats


def _quote(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def _key(name: str) -> str:
    return name if _IDENTIFIER.match(name) else _quote(name)


def _number(value: float) -> str:
    text = repr(float(value))
    return text[:-2] if text.endswith(".0") else text


def _dictionary(values: dict[str, Any], indent: str) -> str:
    """Un dictionnaire USD typé : chaque entrée annonce son type."""
    inner = indent + "    "
    lines = ["{"]
    for key, value in values.items():
        name = _key(str(key))
        if value is None:
            continue
        if isinstance(value, bool):
            lines.append(f"{inner}bool {name} = {'true' if value else 'false'}")
        elif isinstance(value, int):
            lines.append(f"{inner}int {name} = {value}")
        elif isinstance(value, float):
            if math.isfinite(value):
                lines.append(f"{inner}double {name} = {_number(value)}")
        elif isinstance(value, str):
            lines.append(f"{inner}string {name} = {_quote(value)}")
        elif isinstance(value, dict):
            lines.append(f"{inner}dictionary {name} = {_dictionary(value, inner)}")
        elif isinstance(value, (list, tuple)):
            items = ", ".join(_quote(item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)) for item in value)
            lines.append(f"{inner}string[] {name} = [{items}]")
        else:
            lines.append(f"{inner}string {name} = {_quote(str(value))}")
    lines.append(indent + "}")
    return "\n".join(lines)


def _vectors(array: np.ndarray) -> str:
    rounded = np.round(array.astype(np.float64), 6)
    return ", ".join(f"({_number(x)}, {_number(y)}, {_number(z)})" for x, y, z in rounded.tolist())


def _matrix(matrix: tuple[float, ...]) -> str:
    # glTF range la matrice colonne par colonne ; USD écrit des lignes dont la dernière est la
    # translation : les 16 nombres se lisent donc dans le même ordre.
    rows = [", ".join(_number(v) for v in matrix[i : i + 4]) for i in range(0, 16, 4)]
    return "( (" + "), (".join(rows) + ") )"


def _prim_name(prefix: str, raw: str, used: set[str]) -> str:
    name = prefix + re.sub(r"[^A-Za-z0-9_]", "_", raw)
    candidate = name
    counter = 2
    while candidate in used:
        candidate = f"{name}_{counter}"
        counter += 1
    used.add(candidate)
    return candidate


# -------------------------------------------------------------------- écriture


def _material(index: int, material: MaterialData, indent: str) -> str:
    inner = indent + "    "
    r, g, b, a = material.rgba
    return f"""{indent}def Material "M_{index}" (
{inner}customData = {{
{inner}    string name = {_quote(material.name)}
{inner}}}
{indent})
{indent}{{
{inner}token outputs:surface.connect = <{ROOT}/Materials/M_{index}/Shader.outputs:surface>

{inner}def Shader "Shader"
{inner}{{
{inner}    uniform token info:id = "UsdPreviewSurface"
{inner}    color3f inputs:diffuseColor = ({_number(r)}, {_number(g)}, {_number(b)})
{inner}    float inputs:opacity = {_number(a)}
{inner}    float inputs:roughness = 0.9
{inner}    float inputs:metallic = 0
{inner}    token outputs:surface
{inner}}}
{indent}}}"""


def _primitive(index: int, primitive: Primitive, material: MaterialData, indent: str) -> str:
    inner = indent + "    "
    triangles = len(primitive.indices) // 3
    lines = [
        f'{indent}def Mesh "Part_{index}" (',
        f'{inner}prepend apiSchemas = ["MaterialBindingAPI"]',
        f"{indent})",
        f"{indent}{{",
        f"{inner}int[] faceVertexCounts = [{', '.join(['3'] * triangles)}]",
        f"{inner}int[] faceVertexIndices = [{', '.join(map(str, primitive.indices.tolist()))}]",
        f"{inner}point3f[] points = [{_vectors(primitive.positions)}]",
    ]
    if primitive.normals is not None:
        lines.append(f'{inner}normal3f[] normals = [{_vectors(primitive.normals)}] (\n{inner}    interpolation = "vertex"\n{inner})')
    lines.append(f'{inner}uniform token subdivisionScheme = "none"')
    if material.double_sided:
        lines.append(f"{inner}bool doubleSided = 1")
    lines.append(f"{inner}rel material:binding = <{ROOT}/Materials/M_{primitive.material}>")
    lines.append(f"{indent}}}")
    return "\n".join(lines)


def _prototype(index: int, mesh: MeshData, scene: Scene, indent: str) -> str:
    inner = indent + "    "
    parts = "\n\n".join(_primitive(i, primitive, scene.materials[primitive.material], inner) for i, primitive in enumerate(mesh.primitives))
    # Un prim de classe n'est pas affiché par lui-même : il ne sert que de modèle aux éléments.
    return f'{indent}class Xform "Mesh_{index}"\n{indent}{{\n{parts}\n{indent}}}'


def _placement(matrix: tuple[float, ...], indent: str) -> str:
    return f'{indent}matrix4d xformOp:transform = {_matrix(matrix)}\n{indent}uniform token[] xformOpOrder = ["xformOp:transform"]'


def _element(element: ElementData, entry: dict[str, Any] | None, used: set[str], indent: str) -> str:
    inner = indent + "    "
    name = _prim_name("E_", element.guid, used)
    custom: dict[str, Any] = {"id": element.guid}
    if element.name:
        custom["name"] = element.name
    if entry:
        if entry.get("label"):
            custom["label"] = entry["label"]
        custom["properties"] = entry.get("properties") or {}
    metadata = [f"{inner}customData = {_dictionary(custom, inner)}"]
    if len(element.placements) == 1:
        mesh_index, matrix = element.placements[0]
        metadata.insert(0, f"{inner}references = <{ROOT}/Prototypes/Mesh_{mesh_index}>")
        body = _placement(matrix, inner)
    else:
        # Plusieurs formes pour un même élément : un prim enfant par forme.
        parts = []
        for part, (mesh_index, matrix) in enumerate(element.placements):
            parts.append(
                f'{inner}def Xform "Part_{part}" (\n{inner}    references = <{ROOT}/Prototypes/Mesh_{mesh_index}>\n{inner})\n'
                f"{inner}{{\n{_placement(matrix, inner + '    ')}\n{inner}}}"
            )
        body = "\n\n".join(parts)
    return f'{indent}def Xform "{name}" (\n' + "\n".join(metadata) + f"\n{indent})\n{indent}{{\n{body}\n{indent}}}"


def _georeference_layer_data(position: dict | None) -> str:
    """Position de la maquette sur Terre dans les métadonnées du calque (voir geo/georeference.ts)."""
    if not position:
        return ""
    origin = position.get("origin", [0.0, 0.0, 0.0])
    north = position.get("trueNorth", [0.0, 1.0])
    lines = [
        "dictionary georeference = {",
        f"            double latitude = {float(position['latitude'])!r}",
        f"            double longitude = {float(position['longitude'])!r}",
        f"            double elevation = {float(position.get('elevation', 0.0))!r}",
        f"            double3 origin = ({float(origin[0])!r}, {float(origin[1])!r}, {float(origin[2])!r})",
        f"            double2 trueNorth = ({float(north[0])!r}, {float(north[1])!r})",
        f"            string source = {_quote(str(position.get('source', 'IfcSite')))}",
        "        }",
    ]
    return "\n        " + "\n        ".join(lines)


def write_usda(scene: Scene, metadata: dict[str, Any], generator: str = "viewer-bim") -> str:
    """Scène convertie au format USD texte. Les métadonnées sont écrites dans chaque élément."""
    entries = metadata.get("elements", {}) if metadata else {}
    used: set[str] = set()
    indent = "    "
    materials = "\n\n".join(_material(i, material, indent * 2) for i, material in enumerate(scene.materials))
    prototypes = "\n\n".join(_prototype(i, mesh, scene, indent * 2) for i, mesh in enumerate(scene.meshes))
    elements = "\n\n".join(_element(element, entries.get(element.guid), used, indent * 2) for element in scene.elements)
    return f"""#usda 1.0
(
    defaultPrim = "IFC"
    doc = {_quote(generator)}
    metersPerUnit = 1
    upAxis = "Z"
    customLayerData = {{
        int contractVersion = {CONTRACT_VERSION}
        string generator = {_quote(generator)}
        string[] readOnly = [{', '.join(_quote(item) for item in (metadata or {}).get('readOnly', []))}]{_georeference_layer_data((metadata or {}).get('georeference'))}
    }}
)

def Xform "IFC" (
    kind = "assembly"
)
{{
    def Scope "Materials"
    {{
{materials}
    }}

    def Scope "Prototypes"
    {{
{prototypes}
    }}

    def Scope "Elements"
    {{
{elements}
    }}
}}
"""


def write_usdz(usda: str, name: str = "model.usda") -> bytes:
    """Paquet USDZ : une archive zip sans compression, données alignées sur 64 octets."""
    data = usda.encode("utf-8")
    filename = name.encode("utf-8")
    crc = zlib.crc32(data) & 0xFFFFFFFF
    header_length = 30 + len(filename)
    padding = (-header_length) % 64  # le contenu doit commencer sur un multiple de 64 octets
    extra = b"\x1f\x1f" + struct.pack("<H", padding - 4) + b"\x00" * (padding - 4) if padding else b""
    local = struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, 0, 0, 0, 0, crc, len(data), len(data), len(filename), len(extra)) + filename + extra
    central = (
        struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, 20, 20, 0, 0, 0, 0, crc, len(data), len(data), len(filename), 0, 0, 0, 0, 0, 0)
        + filename
    )
    offset = len(local) + len(data)
    end = struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, 1, 1, len(central), offset, 0)
    return local + data + central + end


# ------------------------------------------------------- lecture d'un GLB


def scene_from_glb(glb: bytes) -> Scene:
    """Relit un GLB produit par ce convertisseur (ou plusieurs tranches fusionnées) en scène."""
    if len(glb) < 20 or struct.unpack_from("<I", glb, 0)[0] != 0x46546C67:
        raise ValueError("Fichier GLB invalide.")
    json_length = struct.unpack_from("<I", glb, 12)[0]
    document = json.loads(glb[20 : 20 + json_length])
    binary_header = 20 + json_length
    binary = glb[binary_header + 8 : binary_header + 8 + struct.unpack_from("<I", glb, binary_header)[0]] if binary_header + 8 <= len(glb) else b""

    def accessor(index: int, dtype: Any) -> np.ndarray:
        entry = document["accessors"][index]
        view = document["bufferViews"][entry["bufferView"]]
        start = view.get("byteOffset", 0) + entry.get("byteOffset", 0)
        width = {"SCALAR": 1, "VEC3": 3, "VEC4": 4}[entry["type"]]
        array = np.frombuffer(binary, dtype=dtype, count=entry["count"] * width, offset=start)
        return array.reshape(-1, width) if width > 1 else array

    scene = Scene()
    for material in document.get("materials", []):
        pbr = material.get("pbrMetallicRoughness", {})
        rgba = tuple(pbr.get("baseColorFactor", [1, 1, 1, 1]))
        scene.materials.append(MaterialData(material.get("name", "Défaut"), rgba, bool(material.get("doubleSided"))))  # type: ignore[arg-type]
    colour_materials: dict[tuple, int] = {}
    for mesh in document.get("meshes", []):
        primitives = []
        triangles = 0
        for primitive in mesh["primitives"]:
            attributes = primitive["attributes"]
            index_entry = document["accessors"][primitive["indices"]]
            indices = accessor(primitive["indices"], np.uint16 if index_entry["componentType"] == 5123 else np.uint32).astype(np.int32)
            normals = accessor(attributes["NORMAL"], np.float32) if "NORMAL" in attributes else None
            positions = accessor(attributes["POSITION"], np.float32)
            material_index = primitive.get("material", 0)
            if not scene.materials:
                scene.materials.append(MaterialData("Défaut", (1, 1, 1, 1), False))
            if "COLOR_0" in attributes:
                entry = document["accessors"][attributes["COLOR_0"]]
                dtype = {5121: np.uint8, 5123: np.uint16, 5126: np.float32}[entry["componentType"]]
                colors = accessor(attributes["COLOR_0"], dtype).astype(float)
                if entry.get("normalized") and dtype != np.float32:
                    colors /= np.iinfo(dtype).max
                if colors.shape[1] == 3:
                    colors = np.c_[colors, np.ones(len(colors))]
                material = scene.materials[material_index]
                face_colors = colors[indices.reshape(-1, 3)].mean(axis=1) * np.array(material.rgba)
                # glTF colours are linear floats. Quantising them to bytes darkens subtle
                # colours; retain float precision when grouping uniform triangle colours.
                palette, groups = np.unique(np.round(np.clip(face_colors, 0, 1), 8), axis=0, return_inverse=True)
                for group, color in enumerate(palette):
                    selected = indices.reshape(-1, 3)[groups == group].flatten()
                    vertices, remapped = np.unique(selected, return_inverse=True)
                    rgba = tuple(float(v) for v in color)
                    key = (material.name, rgba, material.double_sided)
                    if key not in colour_materials:
                        colour_materials[key] = len(scene.materials)
                        scene.materials.append(MaterialData(material.name, rgba, material.double_sided))
                    color_material = colour_materials[key]
                    primitives.append(Primitive(positions[vertices], normals[vertices] if normals is not None else None, remapped.astype(np.int32), color_material))
            else:
                primitives.append(Primitive(positions, normals, indices, material_index))
            triangles += len(indices) // 3
        scene.meshes.append(MeshData(primitives, triangles))

    # Both converter GLBs (one axis-conversion root) and edited GLBs (flat scene roots) are
    # valid inputs. Accumulate all transforms, including translation/rotation/scale, then
    # convert glTF Y-up metres back to IFC/USD Z-up metres.
    nodes = document["nodes"]
    y_to_z = np.array([[1, 0, 0, 0], [0, 0, -1, 0], [0, 1, 0, 0], [0, 0, 0, 1]], dtype=float)
    elements: dict[str, tuple[str | None, list]] = {}
    def matrix_of(node: dict) -> np.ndarray:
        if "matrix" in node:
            return np.array(node["matrix"], dtype=float).reshape(4, 4).T
        matrix = np.eye(4)
        x, y, z, w = node.get("rotation", [0, 0, 0, 1])
        rotation = np.array([[1-2*y*y-2*z*z, 2*x*y-2*z*w, 2*x*z+2*y*w],
                             [2*x*y+2*z*w, 1-2*x*x-2*z*z, 2*y*z-2*x*w],
                             [2*x*z-2*y*w, 2*y*z+2*x*w, 1-2*x*x-2*y*y]])
        matrix[:3, :3] = rotation @ np.diag(node.get("scale", [1, 1, 1]))
        matrix[:3, 3] = node.get("translation", [0, 0, 0])
        return matrix
    def visit(index: int, parent: np.ndarray, owner: str | None, ancestors: set[int]) -> None:
        if index in ancestors:
            raise ValueError("Hiérarchie GLB cyclique.")
        node = nodes[index]
        world = parent @ matrix_of(node)
        identifier = node.get("extras", {}).get("id")
        if identifier is not None:
            owner = str(identifier)
            elements.setdefault(owner, (node.get("name"), []))
        if "mesh" in node:
            if owner is None:
                owner = str(node.get("name") or f"node-{index}")
            elements.setdefault(owner, (node.get("name"), []))[1].append((node["mesh"], tuple((y_to_z @ world).T.flatten())))
        for child in node.get("children", []):
            visit(child, world, owner, ancestors | {index})
    roots = document.get("scenes", [{}])[document.get("scene", 0)].get("nodes", [])
    for index in roots:
        visit(index, np.eye(4), None, set())
    for guid, (name, placements) in elements.items():
        scene.element(guid, name, placements)
    return scene
