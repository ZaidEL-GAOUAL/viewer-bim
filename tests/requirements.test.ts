import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PropertyStore } from '../src/data/metadata.ts';
import { checkRequirements, failuresCsv, parseIds, parseRequirementList, type IdsMapping } from '../src/data/requirements.ts';
import ifc from '../src/data/presets/quantites-ifc.json' with { type: 'json' };

const mapping = ifc as IdsMapping;

function store(): PropertyStore {
  const out = new PropertyStore(4);
  out.set(0, { 'Classe IFC': 'IfcWall', 'Pset_WallCommon / FireRating': 'REI60' }, 'Mur 1');
  out.set(1, { 'Classe IFC': 'IfcWall', 'Pset_WallCommon / FireRating': '' }, 'Mur 2');
  out.set(2, { 'Classe IFC': 'IfcWall' }, 'Mur 3');
  out.set(3, { 'Classe IFC': 'IfcSlab' }, 'Dalle');
  out.finalize();
  return out;
}

test('a required property: missing and empty fail, present passes, other elements are not concerned', () => {
  const rules = parseRequirementList('# murs\nClasse IFC = IfcWall -> Pset_WallCommon / FireRating');
  const failures = checkRequirements(store(), rules);
  assert.deepEqual(failures.map((failure) => [failure.element, failure.property, failure.required, failure.actual]), [
    [1, 'Pset_WallCommon / FireRating', 'renseignée', '(non défini)'],
    [2, 'Pset_WallCommon / FireRating', 'renseignée', '(non défini)'],
  ]);
  const valued = checkRequirements(store(), parseRequirementList('* -> Pset_WallCommon / FireRating = REI 60'));
  assert.equal(valued.length, 4, 'a required value must match: « REI60 » is not « REI 60 »');
  assert.throws(() => parseRequirementList('Classe IFC'), /éléments -> propriétés/);
  const csv = failuresCsv(failures, rules, ['a', 'b', 'c', 'd'], (i) => `Mur ${i + 1}`);
  assert.equal(csv.split('\r\n')[1], 'Classe IFC = IfcWall -> Pset_WallCommon / FireRating;Mur 2;b;Pset_WallCommon / FireRating;renseignée;(non défini)');
});

const IDS = `<?xml version="1.0" encoding="UTF-8"?>
<ids:ids xmlns:ids="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <ids:info><ids:title>Murs &amp; dalles</ids:title></ids:info>
  <ids:specifications>
    <ids:specification name="Murs coupe-feu" ifcVersion="IFC4">
      <ids:applicability minOccurs="0" maxOccurs="unbounded">
        <ids:entity><ids:name><ids:simpleValue>IFCWALL</ids:simpleValue></ids:name></ids:entity>
      </ids:applicability>
      <ids:requirements>
        <ids:property cardinality="required">
          <ids:propertySet><ids:simpleValue>Pset_WallCommon</ids:simpleValue></ids:propertySet>
          <ids:baseName><ids:simpleValue>FireRating</ids:simpleValue></ids:baseName>
        </ids:property>
        <ids:attribute cardinality="required"><ids:name><ids:simpleValue>Name</ids:simpleValue></ids:name></ids:attribute>
        <ids:material cardinality="required"/>
      </ids:requirements>
    </ids:specification>
    <ids:specification name="Classées" ifcVersion="IFC4">
      <ids:applicability><ids:classification><ids:system><ids:simpleValue>Uniclass</ids:simpleValue></ids:system></ids:classification></ids:applicability>
      <ids:requirements><ids:attribute><ids:name><ids:simpleValue>Description</ids:simpleValue></ids:name></ids:attribute></ids:requirements>
    </ids:specification>
  </ids:specifications>
</ids:ids>`;

test('an IDS with entity and property facets parses to the expected rules; unsupported facets are reported', () => {
  const { title, rules, unsupported } = parseIds(IDS, mapping);
  assert.equal(title, 'Murs & dalles');
  assert.deepEqual(rules, [{
    name: 'Murs coupe-feu',
    applies: [{ property: 'Classe IFC', op: 'equals', value: 'IFCWALL' }],
    requirements: [
      { property: 'Pset_WallCommon / FireRating', cardinality: 'required' },
      { property: '#nom', cardinality: 'required' },
    ],
  }]);
  assert.deepEqual(unsupported, [
    '« Murs coupe-feu » : facette « material » non prise en charge',
    '« Classées » : facette « classification » non prise en charge',
    '« Classées » : spécification non vérifiée, son applicabilité utilise ce que le viewer ne sait pas lire',
  ]);
  // The class matches whatever its case; the name comes from the element's label.
  const failures = checkRequirements(store(), rules, { keys: ['a', 'b', 'c', 'd'], label: (i) => store().labelOf(i) ?? '' });
  assert.deepEqual(failures.map((failure) => failure.element), [1, 2]);
});

test('malformed XML is refused, not half read', () => {
  assert.throws(() => parseIds('<ids:ids><ids:specifications></ids:ids>', mapping), /mal formé/);
  assert.throws(() => parseIds('<other/>', mapping), /pas un IDS/);
});
