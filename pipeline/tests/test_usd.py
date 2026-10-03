"""Tests de l'écriture USD, vérifiés avec la bibliothèque officielle OpenUSD (usd-core).

    uv run --no-project --with ifcopenshell --with numpy --with usd-core --with pytest pytest pipeline/tests
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest
import struct
import zipfile

from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import ifc_to_glb  # noqa: E402
import usd_writer  # noqa: E402
from make_sample_ifc import ORIGIN, build  # noqa: E402


@pytest.fixture(scope="module")
def conversion():
    return ifc_to_glb.convert(build())


@pytest.fixture(scope="module")
def stage(conversion, tmp_path_factory):
    path = tmp_path_factory.mktemp("usd") / "demo.usda"
    path.write_text(conversion.usda(), encoding="utf-8")
    opened = Usd.Stage.Open(str(path))
    assert opened is not None, "OpenUSD doit pouvoir ouvrir le fichier"
    return opened


def elements(stage: Usd.Stage) -> list[Usd.Prim]:
    return [prim for prim in stage.GetPrimAtPath("/IFC/Elements").GetChildren()]


def test_each_element_is_a_prim_carrying_its_ifc_identifier_and_metadata(conversion, stage):
    prims = elements(stage)
    assert len(prims) == 26
    ids = {prim.GetCustomDataByKey("id") for prim in prims}
    assert ids == set(conversion.metadata["elements"])
    wall = next(prim for prim in prims if prim.GetCustomDataByKey("name") == "Mur sud RDC")
    properties = wall.GetCustomDataByKey("properties")
    assert properties["Classe IFC"] == "IfcWall"
    assert properties["Niveau"] == "RDC"
    assert properties["Pset_WallCommon"]["IsExternal"] is True
    assert properties["Qto_WallBaseQuantities"]["NetVolume"] == pytest.approx(5.6)
    assert stage.GetMetadata("upAxis") == "Z"
    assert stage.GetMetadata("metersPerUnit") == 1
    assert stage.GetDefaultPrim().GetPath() == "/IFC"


def test_geometry_is_shared_through_prototypes_and_placed_in_project_coordinates(stage):
    prims = elements(stage)
    columns = [prim for prim in prims if prim.GetCustomDataByKey("name").startswith("Poteau")]
    assert len(columns) == 12
    # Les douze poteaux référencent le même prototype.
    targets = {column.GetMetadata("references").GetAddedOrExplicitItems()[0].primPath for column in columns}
    assert len(targets) == 1
    assert stage.GetPrimAtPath(targets.pop()).GetSpecifier() == Sdf.SpecifierClass

    slab = next(prim for prim in prims if prim.GetCustomDataByKey("name") == "Dalle RDC")
    xform = UsdGeom.Xformable(slab)
    translation = xform.GetLocalTransformation().ExtractTranslation()
    assert translation[0] == pytest.approx(ORIGIN[0])
    assert translation[1] == pytest.approx(ORIGIN[1])
    assert translation[2] == pytest.approx(ORIGIN[2] - 0.2)
    # Le maillage référencé est bien composé sous l'élément : points en mètres, triangles.
    mesh = next(child for child in Usd.PrimRange(slab) if child.IsA(UsdGeom.Mesh))
    geom = UsdGeom.Mesh(mesh)
    counts = geom.GetFaceVertexCountsAttr().Get()
    assert set(counts) == {3}
    points = np.array(geom.GetPointsAttr().Get())
    assert points.min(axis=0) == pytest.approx([0, 0, 0], abs=1e-5)
    assert points.max(axis=0) == pytest.approx([10, 6, 0.2], abs=1e-5)
    assert len(geom.GetNormalsAttr().Get()) == len(points)
    assert geom.GetNormalsInterpolation() == "vertex"


def test_materials_are_bound_with_colour_and_opacity(stage):
    prims = elements(stage)
    window = next(prim for prim in prims if prim.GetCustomDataByKey("name") == "Fenêtre RDC")
    mesh = next(child for child in Usd.PrimRange(window) if child.IsA(UsdGeom.Mesh))
    material = UsdShade.MaterialBindingAPI(mesh).ComputeBoundMaterial()[0]
    assert material.GetPrim().GetCustomDataByKey("name") == "Verre"
    shader = UsdShade.Shader(material.GetPrim().GetChild("Shader"))
    assert shader.GetIdAttr().Get() == "UsdPreviewSurface"
    assert shader.GetInput("opacity").Get() == pytest.approx(0.35)
    colour = shader.GetInput("diffuseColor").Get()
    assert colour[2] > colour[0]  # du verre bleuté


def test_usdz_package_is_valid(conversion, tmp_path):
    path = tmp_path / "demo.usdz"
    path.write_bytes(conversion.usdz())
    # Règles du format USDZ : archive zip sans compression, données alignées sur 64 octets.
    with zipfile.ZipFile(path) as archive:
        assert archive.testzip() is None
        (info,) = archive.infolist()
        assert info.filename == "model.usda"
        assert info.compress_type == zipfile.ZIP_STORED
    # Le début des données se lit dans l'en-tête local : nom et champ supplémentaire.
    raw = path.read_bytes()
    name_length, extra_length = struct.unpack_from("<HH", raw, info.header_offset + 26)
    data_offset = info.header_offset + 30 + name_length + extra_length
    assert data_offset % 64 == 0
    stage = Usd.Stage.Open(str(path))
    assert len(elements(stage)) == 26


def test_scene_can_be_rebuilt_from_a_glb_and_written_to_usd(conversion, tmp_path):
    rebuilt = usd_writer.scene_from_glb(conversion.glb)
    assert len(rebuilt.elements) == len(conversion.scene.elements)
    assert len(rebuilt.meshes) == len(conversion.scene.meshes)
    assert [m.rgba for m in rebuilt.materials] == [m.rgba for m in conversion.scene.materials]
    path = tmp_path / "rebuilt.usda"
    path.write_text(usd_writer.write_usda(rebuilt, conversion.metadata), encoding="utf-8")
    stage = Usd.Stage.Open(str(path))
    assert {prim.GetCustomDataByKey("id") for prim in elements(stage)} == set(conversion.metadata["elements"])
    bbox = UsdGeom.BBoxCache(Usd.TimeCode.Default(), ["default"]).ComputeWorldBound(stage.GetPrimAtPath("/IFC")).ComputeAlignedBox()
    size = bbox.GetMax() - bbox.GetMin()
    assert size[0] == pytest.approx(10, abs=0.01)
    assert size[2] == pytest.approx(6, abs=0.01)  # Z vers le haut : hauteur du bâtiment
    assert isinstance(bbox.GetMin(), Gf.Vec3d)


def test_layer_carries_the_read_only_list(conversion, stage):
    data = stage.GetRootLayer().customLayerData
    assert list(data["readOnly"]) == conversion.metadata["readOnly"]
    assert data["contractVersion"] == 1
