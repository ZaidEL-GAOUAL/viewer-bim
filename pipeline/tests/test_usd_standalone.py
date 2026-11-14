"""L'écriture USD ne charge pas IfcOpenShell : le navigateur n'a pas à installer le moteur IFC pour l'utiliser."""

import subprocess
import sys
from pathlib import Path

PIPELINE = Path(__file__).resolve().parents[1]

PROGRAM = """
import sys
sys.path.insert(0, sys.argv[1])
sys.modules['ifcopenshell'] = None  # tout import d'IfcOpenShell échoue
import usd_writer
from scene import Scene
text = usd_writer.write_usda(Scene(), {"elements": {}})
assert 'upAxis = "Z"' in text
assert not any(name.startswith('ifcopenshell') or name == 'ifc_to_glb' for name in sys.modules if sys.modules[name] is not None)
"""


def test_usd_writer_imports_without_ifcopenshell():
    result = subprocess.run([sys.executable, "-I", "-c", PROGRAM, str(PIPELINE)], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
