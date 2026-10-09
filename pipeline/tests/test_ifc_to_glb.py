"""Tests du convertisseur IFC → GLB + JSON.

    uv run --no-project --with ifcopenshell --with numpy --with pytest pytest pipeline/tests
"""

from __future__ import annotations

import json
import struct
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import ifc_to_glb  # noqa: E402
from make_sample_ifc import ORIGIN, build  # noqa: E402


def parse_glb(data: bytes) -> tuple[dict, bytes]:
    magic, version, length = struct.unpack_from("<III", data, 0)
    assert magic == 0x46546C67 and version == 2 and length == len(data)
    json_length, json_type = struct.unpack_from("<II", data, 12)
    assert json_type == 0x4E4F534A and json_length % 4 == 0
    document = json.loads(data[20 : 20 + json_length])
    offset = 20 + json_length
    binary_length, binary_type = struct.unpack_from("<II", data, offset)
    assert binary_type == 0x004E4942
    return document, data[offset + 8 : offset + 8 + binary_length]


@pytest.fixture(scope="module", params=["IFC4", "IFC2X3"])
def result(request):
    return ifc_to_glb.convert(build(version=request.param))


def element_nodes(document: dict) -> list[dict]:
    return [document["nodes"][index] for index in document["nodes"][0]["children"]]


def test_each_element_keeps_its_ifc_identifier(result):
    document, _ = parse_glb(result.glb)
    nodes = element_nodes(document)
    ids = [node["extras"]["id"] for node in nodes]
    # 2 niveaux × (1 dalle + 4 murs + 1 fenêtre + 6 poteaux + 1 porte)
    assert len(ids) == 26
    assert len(set(ids)) == 26
    assert all(len(identifier) == 22 for identifier in ids)
    # Chaque nœud du GLB a son entrée dans le JSON, et inversement : c'est le lien du contrat.
    assert set(ids) == set(result.metadata["elements"])
    assert result.metadata["version"] == 1
    assert result.report["elements"] == 26


def test_spaces_and_openings_are_not_exported(result):
    classes = {entry["properties"]["Classe IFC"] for entry in result.metadata["elements"].values()}
    assert classes == {"IfcSlab", "IfcWall", "IfcWindow", "IfcColumn", "IfcDoor"}


def test_grid_lines_are_set_aside_without_counting_as_failures(result):
    # La trame d'axes n'a pas de volume : ni convertie, ni signalée comme un échec.
    assert result.report["linework"] == 1
    assert result.report["without_geometry"] == 0
    assert result.report["failed"] == []
    assert "IfcGrid" not in {entry["properties"]["Classe IFC"] for entry in result.metadata["elements"].values()}


def test_elements_whose_geometry_fails_are_listed():
    model = build()
    wall = model.by_type("IfcWall")[0]
    # Géométrie volontairement cassée : une extrusion de hauteur nulle.
    solid = next(item for representation in wall.Representation.Representations for item in representation.Items)
    solid.Depth = 0.0
    broken = ifc_to_glb.convert(model)
    assert broken.report["without_geometry"] == 1
    assert broken.report["failed"] == [{"id": wall.GlobalId, "class": "IfcWall", "name": wall.Name}]
    assert wall.GlobalId not in broken.metadata["elements"]
    assert len(broken.metadata["elements"]) == 25


def test_metadata_carries_spatial_structure_type_and_property_sets(result):
    by_label = {entry["label"]: entry["properties"] for entry in result.metadata["elements"].values()}
    wall = by_label["Mur sud RDC"]
    assert wall["Site"] == "Campus"
    assert wall["Bâtiment"] == "Bâtiment A"
    assert wall["Niveau"] == "RDC"
    assert wall["Type"] == "Mur béton 20"
    assert wall["Matériaux"] == "Enduit"
    # Jeu de propriétés hérité du type, et quantités propres à l'élément.
    assert wall["Pset_WallCommon"] == {"IsExternal": True, "LoadBearing": True, "FireRating": "REI 120"}
    assert wall["Qto_WallBaseQuantities"]["NetVolume"] == pytest.approx(5.6)
    assert "id" not in wall["Pset_WallCommon"]
    assert by_label["Poteau R+1-3"]["Niveau"] == "R+1"
    assert by_label["Poteau R+1-3"]["Type"] == "Poteau Ø40"
    json.loads(result.metadata_json())  # le JSON produit est valide


def test_glb_is_y_up_in_metres_and_keeps_georeferencing(result):
    document, _ = parse_glb(result.glb)
    assert document["nodes"][0]["matrix"] == ifc_to_glb.Z_UP_TO_Y_UP
    slab = next(node for node in element_nodes(document) if node["name"] == "Dalle RDC")
    # La position de projet (en mètres) reste dans la matrice du nœud, en double précision.
    assert slab["matrix"][12:15] == pytest.approx([ORIGIN[0], ORIGIN[1], ORIGIN[2] - 0.2])
    # Les sommets restent locaux à l'élément et en mètres, bien que l'IFC soit en millimètres.
    accessor = document["accessors"][document["meshes"][slab["mesh"]]["primitives"][0]["attributes"]["POSITION"]]
    assert accessor["min"] == pytest.approx([0, 0, 0], abs=1e-6)
    assert accessor["max"] == pytest.approx([10, 6, 0.2], abs=1e-6)
    # Un poteau de 40 cm de diamètre et 2,80 m de haut, défini en millimètres dans l'IFC.
    column = next(node for node in element_nodes(document) if node["name"] == "Poteau RDC-1")
    accessor = document["accessors"][document["meshes"][column["mesh"]]["primitives"][0]["attributes"]["POSITION"]]
    assert accessor["min"] == pytest.approx([-0.2, -0.2, 0], abs=1e-3)
    assert accessor["max"] == pytest.approx([0.2, 0.2, 2.8], abs=1e-3)


def test_identical_elements_share_one_mesh(result):
    document, _ = parse_glb(result.glb)
    columns = [node for node in element_nodes(document) if node["name"].startswith("Poteau")]
    assert len(columns) == 12
    assert len({node["mesh"] for node in columns}) == 1
    assert result.report["meshes"] == 15


def test_openings_are_cut_and_materials_are_converted(result):
    document, binary = parse_glb(result.glb)
    nodes = {node["name"]: node for node in element_nodes(document)}

    def triangle_count(name: str) -> int:
        return sum(document["accessors"][p["indices"]]["count"] for p in document["meshes"][nodes[name]["mesh"]]["primitives"]) // 3

    assert triangle_count("Mur nord RDC") == 12  # une simple boîte
    assert triangle_count("Mur sud RDC") > 12  # la boîte moins l'ouverture de la fenêtre

    materials = {material["name"]: material for material in document["materials"]}
    glass = materials["Verre"]
    assert glass["alphaMode"] == "BLEND"
    assert glass["pbrMetallicRoughness"]["baseColorFactor"][3] == pytest.approx(0.35)
    assert "alphaMode" not in materials["Béton"]
    # Couleur sRGB de l'IFC (0,62) convertie en linéaire pour glTF.
    assert materials["Béton"]["pbrMetallicRoughness"]["baseColorFactor"][0] == pytest.approx(0.3424, abs=1e-3)
    # Tous les éléments du modèle sont des solides fermés : aucun matériau à double face.
    assert not any(material.get("doubleSided") for material in document["materials"])

    # Tampon binaire cohérent avec les accesseurs.
    for accessor in document["accessors"]:
        view = document["bufferViews"][accessor["bufferView"]]
        assert view["byteOffset"] % 4 == 0
        assert view["byteOffset"] + view["byteLength"] <= len(binary)
    wall = document["meshes"][nodes["Mur nord RDC"]["mesh"]]["primitives"][0]
    normal_view = document["bufferViews"][document["accessors"][wall["attributes"]["NORMAL"]]["bufferView"]]
    normals = np.frombuffer(binary, dtype=np.float32, count=normal_view["byteLength"] // 4, offset=normal_view["byteOffset"]).reshape(-1, 3)
    assert np.allclose(np.linalg.norm(normals, axis=1), 1, atol=1e-4)
    # Normales à plat : chacune est alignée sur un axe.
    assert np.allclose(np.sort(np.abs(normals), axis=1), [0, 0, 1], atol=1e-4)


def test_filters_keep_identifiers_and_metadata():
    model = build()
    walls = ifc_to_glb.convert(model, classes=["IfcWall"])
    assert len(walls.metadata["elements"]) == 8
    assert {entry["properties"]["Classe IFC"] for entry in walls.metadata["elements"].values()} == {"IfcWall"}

    slab = model.by_type("IfcSlab")[0]
    one = ifc_to_glb.convert(model, ids=[slab.GlobalId])
    assert list(one.metadata["elements"]) == [slab.GlobalId]
    assert one.metadata["elements"][slab.GlobalId]["properties"]["Qto_SlabBaseQuantities"]["NetArea"] == 60.0
    document, _ = parse_glb(one.glb)
    assert [node["extras"]["id"] for node in element_nodes(document)] == [slab.GlobalId]


def test_shards_split_the_model_without_losing_or_duplicating_elements():
    model = build()
    whole = ifc_to_glb.convert(model)
    parts = [ifc_to_glb.convert(model, shard=(index, 3)) for index in range(3)]
    ids = [guid for part in parts for guid in part.metadata["elements"]]
    assert len(ids) == len(set(ids)) == 26
    assert set(ids) == set(whole.metadata["elements"])
    assert sum(part.report["triangles"] for part in parts) == whole.report["triangles"]
    # Les compteurs s'additionnent d'une tranche à l'autre sans rien compter deux fois.
    assert sum(part.report["linework"] for part in parts) == whole.report["linework"] == 1
    assert sum(part.report["without_geometry"] for part in parts) == 0
    # Chaque tranche reste un GLB valide dont les nœuds portent leurs identifiants.
    for part in parts:
        document, _ = parse_glb(part.glb)
        assert {node["extras"]["id"] for node in element_nodes(document)} == set(part.metadata["elements"])


def test_spaces_can_be_included():
    with_spaces = ifc_to_glb.convert(build(), include_spaces=True)
    assert len(with_spaces.metadata["elements"]) == 28


def test_closedness_detection():
    cube = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], dtype=float)
    faces = np.array([[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]])
    assert ifc_to_glb._is_closed(cube, faces) is True
    assert ifc_to_glb._is_closed(cube, faces[2:]) is False  # une face en moins
    flipped = faces.copy()
    flipped[0] = flipped[0][::-1]
    assert ifc_to_glb._is_closed(cube, flipped) is False  # une face retournée


def test_model_without_geometry_gives_an_empty_but_valid_glb():
    import ifcopenshell.api

    model = ifcopenshell.api.run("project.create_file", version="IFC4")
    ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcProject", name="Vide")
    empty = ifc_to_glb.convert(model)
    assert empty.metadata == {"version": 1, "readOnly": ifc_to_glb.READ_ONLY, "elements": {}}
    assert empty.glb[:4] == b"glTF"


def test_metadata_declare_the_properties_the_viewer_must_not_edit(result):
    read_only = result.metadata["readOnly"]
    assert read_only == ifc_to_glb.READ_ONLY
    # La classe, la structure spatiale et les quantités y sont ; les jeux de propriétés restent modifiables.
    assert {"Classe IFC", "Niveau", "Matériaux", "Qto_*"} <= set(read_only)
    assert not any(item.startswith("Pset") for item in read_only)
    assert json.loads(result.metadata_json())["readOnly"] == read_only


def test_georeference_comes_from_the_site_and_the_true_north(result):
    position = result.metadata["georeference"]
    assert position["latitude"] == pytest.approx(48.8584, abs=1e-6)
    assert position["longitude"] == pytest.approx(2.2945, abs=1e-6)
    assert position["elevation"] == pytest.approx(35.0)
    assert position["origin"] == [0.0, 0.0, 0.0]
    assert position["trueNorth"] == pytest.approx([0.17364818, 0.98480775], abs=1e-6)
    assert position["source"] == "IfcSite"
    assert "projected" not in position


def test_model_without_site_coordinates_has_no_georeference():
    import ifcopenshell.api

    model = ifcopenshell.api.run("project.create_file", version="IFC4")
    ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcProject", name="Vide")
    ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcSite", name="Sans position")
    assert ifc_to_glb.georeference(model) is None
    assert ifc_to_glb._degrees((45, 44, 50, 634155)) == pytest.approx(45.747398376, abs=1e-9)
    assert ifc_to_glb._degrees((-4, 41, 25)) == pytest.approx(-(4 + 41 / 60 + 25 / 3600))
