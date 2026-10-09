"""Fabrique un petit bâtiment IFC de démonstration, pour tester le convertisseur.

    python make_sample_ifc.py sortie.ifc

Le modèle réunit volontairement les cas qui comptent pour la conversion : unités en
millimètres, site géoréférencé loin de l'origine, types partagés, ouvertures, matériaux
colorés et transparents, jeux de propriétés et de quantités, locaux.
"""

from __future__ import annotations

import sys

import numpy as np

import ifcopenshell
import ifcopenshell.api

ORIGIN = (651_200.0, 6_861_500.0, 35.0)  # coordonnées de projet, en mètres


def build(version: str = "IFC4", storeys: int = 2) -> ifcopenshell.file:
    run = ifcopenshell.api.run
    model = run("project.create_file", version=version)
    levels = [("RDC" if index == 0 else f"R+{index}", 3.0 * index) for index in range(storeys)]
    # IFC2x3 exige un auteur et une application pour l'historique de chaque entité.
    person = run("owner.add_person", model)
    organisation = run("owner.add_organisation", model)
    run("owner.add_person_and_organisation", model, person=person, organisation=organisation)
    run("owner.add_application", model)
    project = run("root.create_entity", model, ifc_class="IfcProject", name="Bâtiment de démonstration")
    run("unit.assign_unit", model)  # millimètres par défaut
    context = run("context.add_context", model, context_type="Model")
    body = run("context.add_context", model, context_type="Model", context_identifier="Body", target_view="MODEL_VIEW", parent=context)

    site = run("root.create_entity", model, ifc_class="IfcSite", name="Campus")
    # Géoréférencement : Paris, Champ-de-Mars (48°51′30,24″ N, 2°17′40,2″ E), 35 m, nord tourné de 10°.
    site.RefLatitude = (48, 51, 30, 240000)
    site.RefLongitude = (2, 17, 40, 200000)
    site.RefElevation = 35000.0  # millimètres, comme le reste du modèle
    context.TrueNorth = model.createIfcDirection((0.17364818, 0.98480775))
    building = run("root.create_entity", model, ifc_class="IfcBuilding", name="Bâtiment A")
    run("aggregate.assign_object", model, relating_object=project, products=[site])
    run("aggregate.assign_object", model, relating_object=site, products=[building])

    def style(name: str, rgb: tuple[float, float, float], transparency: float = 0.0):
        item = run("style.add_style", model, name=name)
        attributes = {"SurfaceColour": {"Name": None, "Red": rgb[0], "Green": rgb[1], "Blue": rgb[2]}, "Transparency": transparency}
        ifc_class = "IfcSurfaceStyleShading"
        if version == "IFC2X3":
            # En IFC2x3, la transparence n'existe que sur le style de rendu.
            ifc_class = "IfcSurfaceStyleRendering"
            attributes["ReflectanceMethod"] = "FLAT"
        run("style.add_surface_style", model, style=item, ifc_class=ifc_class, attributes=attributes)
        return item

    def material(name: str, rgb: tuple[float, float, float], transparency: float = 0.0):
        item = run("material.add_material", model, name=name)
        run("style.assign_material_style", model, material=item, style=style(name, rgb, transparency), context=body)
        return item

    concrete = material("Béton", (0.62, 0.62, 0.6))
    plaster = material("Enduit", (0.87, 0.84, 0.76))
    wood = material("Bois", (0.5, 0.33, 0.18))
    glass = material("Verre", (0.45, 0.7, 0.85), 0.65)

    def place(product, x: float, y: float, z: float, angle: float = 0.0) -> None:
        cos, sin = np.cos(np.radians(angle)), np.sin(np.radians(angle))
        matrix = np.array([[cos, -sin, 0, ORIGIN[0] + x], [sin, cos, 0, ORIGIN[1] + y], [0, 0, 1, ORIGIN[2] + z], [0, 0, 0, 1]], dtype=float)
        run("geometry.edit_object_placement", model, product=product, matrix=matrix)

    def box(length: float, thickness: float, height: float):
        return run("geometry.add_wall_representation", model, context=body, length=length, height=height, thickness=thickness)

    wall_type = run("root.create_entity", model, ifc_class="IfcWallType", name="Mur béton 20")
    type_pset = run("pset.add_pset", model, product=wall_type, name="Pset_WallCommon")
    run("pset.edit_pset", model, pset=type_pset, properties={"IsExternal": True, "LoadBearing": True, "FireRating": "REI 120"})

    column_type = run("root.create_entity", model, ifc_class="IfcColumnType", name="Poteau Ø40")
    # Créé directement : les valeurs sont dans l'unité du projet (millimètres), et IFC2x3 exige
    # la position du profil.
    centre = model.create_entity("IfcAxis2Placement2D", Location=model.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0)))
    circle = model.create_entity("IfcCircleProfileDef", ProfileType="AREA", Position=centre, Radius=200.0)
    column_shape = run("geometry.add_profile_representation", model, context=body, profile=circle, depth=2.8)
    run("geometry.assign_representation", model, product=column_type, representation=column_shape)
    run("material.assign_material", model, products=[column_type], material=concrete)

    for name, elevation in levels:
        storey = run("root.create_entity", model, ifc_class="IfcBuildingStorey", name=name)
        run("aggregate.assign_object", model, relating_object=building, products=[storey])
        place(storey, 0, 0, elevation)

        def add(ifc_class: str, label: str, representation, position: tuple[float, float, float], angle: float = 0.0, mat=None):
            product = run("root.create_entity", model, ifc_class=ifc_class, name=label)
            if representation is not None:
                run("geometry.assign_representation", model, product=product, representation=representation)
            place(product, position[0], position[1], elevation + position[2], angle)
            if ifc_class == "IfcSpace":
                # Un local fait partie de la structure spatiale : il se rattache au niveau par décomposition.
                run("aggregate.assign_object", model, relating_object=storey, products=[product])
            else:
                run("spatial.assign_container", model, relating_structure=storey, products=[product])
            if mat is not None:
                run("material.assign_material", model, products=[product], material=mat)
            return product

        slab_shape = run("geometry.add_slab_representation", model, context=body, depth=0.2, polyline=[(0.0, 0.0), (10.0, 0.0), (10.0, 6.0), (0.0, 6.0)])
        slab = add("IfcSlab", f"Dalle {name}", slab_shape, (0, 0, -0.2), mat=concrete)
        quantities = run("pset.add_qto", model, product=slab, name="Qto_SlabBaseQuantities")
        run("pset.edit_qto", model, qto=quantities, properties={"NetVolume": 12.0, "NetArea": 60.0, "Depth": 200.0})

        walls = [
            ("Mur sud", (0, 0, 0), 0, 10),
            ("Mur nord", (0, 5.8, 0), 0, 10),
            ("Mur ouest", (0.2, 0.2, 0), 90, 5.6),
            ("Mur est", (10, 0.2, 0), 90, 5.6),
        ]
        for label, position, angle, length in walls:
            wall = add("IfcWall", f"{label} {name}", box(length, 0.2, 2.8), position, angle, mat=plaster)
            run("type.assign_type", model, related_objects=[wall], relating_type=wall_type)
            quantities = run("pset.add_qto", model, product=wall, name="Qto_WallBaseQuantities")
            run("pset.edit_qto", model, qto=quantities, properties={"Length": length * 1000, "Height": 2800.0, "NetVolume": round(length * 0.2 * 2.8, 3)})
            if label == "Mur sud":
                # Une fenêtre : l'ouverture est soustraite du mur, le vitrage la remplit.
                opening = run("root.create_entity", model, ifc_class="IfcOpeningElement", name="Réservation fenêtre")
                run("geometry.assign_representation", model, product=opening, representation=box(1.6, 0.4, 1.3))
                place(opening, 4.2, -0.1, elevation + 0.9)
                run("feature.add_feature", model, feature=opening, element=wall)
                window = add("IfcWindow", f"Fenêtre {name}", box(1.6, 0.05, 1.3), (4.2, 0.075, 0.9), mat=glass)
                run("feature.add_filling", model, opening=opening, element=window)
                window_pset = run("pset.add_pset", model, product=window, name="Pset_WindowCommon")
                run("pset.edit_pset", model, pset=window_pset, properties={"ThermalTransmittance": 1.3, "IsExternal": True})

        for index, (x, y) in enumerate([(2.5, 2), (5, 2), (7.5, 2), (2.5, 4), (5, 4), (7.5, 4)]):
            column = add("IfcColumn", f"Poteau {name}-{index + 1}", None, (x, y, 0))
            run("type.assign_type", model, related_objects=[column], relating_type=column_type)

        door = add("IfcDoor", f"Porte {name}", box(0.9, 0.04, 2.1), (6.5, 2.98, 0), mat=wood)
        door_pset = run("pset.add_pset", model, product=door, name="Pset_DoorCommon")
        run("pset.edit_pset", model, pset=door_pset, properties={"FireRating": "EI 30", "IsExternal": False})

        space = add("IfcSpace", f"Plateau {name}", box(9.6, 5.4, 2.8), (0.2, 0.2, 0))
        space.LongName = "Plateau de bureaux"

    # Une trame d'axes : des lignes sans volume, que le convertisseur doit laisser de côté.
    grid = run("root.create_entity", model, ifc_class="IfcGrid", name="Trame")
    points = [model.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0)), model.create_entity("IfcCartesianPoint", Coordinates=(10000.0, 0.0))]
    line = model.create_entity("IfcPolyline", Points=points)
    axis = model.create_entity("IfcGridAxis", AxisTag="A", AxisCurve=line, SameSense=True)
    grid.UAxes = [axis]
    grid.VAxes = [model.create_entity("IfcGridAxis", AxisTag="1", AxisCurve=model.create_entity("IfcPolyline", Points=points[::-1]), SameSense=True)]
    curves = model.create_entity("IfcGeometricCurveSet", Elements=[line])
    footprint = model.create_entity("IfcShapeRepresentation", ContextOfItems=body, RepresentationIdentifier="FootPrint", RepresentationType="GeometricCurveSet", Items=[curves])
    grid.Representation = model.create_entity("IfcProductDefinitionShape", Representations=[footprint])
    place(grid, 0, 0, 0)

    return model


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "demo.ifc"
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    build(storeys=count).write(target)
    print(f"→ {target}")
