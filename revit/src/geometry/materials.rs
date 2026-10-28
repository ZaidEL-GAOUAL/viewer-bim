//! Les matériaux des formes enregistrées : le résolveur de rvt-rs (matériau de l'élément, marqueurs de
//! face, style de rendu, apparence), avec un rattrapage pour une couleur d'apparence jamais calculée.
//!
//! Un matériau qui coche « Utiliser l'apparence de rendu pour l'ombrage » prend, chez rvt-rs, la couleur de
//! son élément d'apparence (`AppearanceAsset.m_color`). Cette couleur peut n'avoir jamais été calculée :
//! l'élément garde 0 (noir) alors que son diffuse est ailleurs (RE1-Architecture : « Generic » et
//! « Generic(1) » ont `m_color` = 0 et un diffuse de 0,315). Le matériau, lui, a la bonne couleur d'ombrage
//! (`Material.m_color`, Graphiques > Ombrage : 0xFFFFFF pour « White », 0xD7D7D7 pour « Light Grey », les
//! couleurs que l'export IFC de Revit écrit aussi) ; sans elle, le mobilier du fichier sortait noir.
//!
//! Le rattrapage : quand la couleur résolue est exactement noire et que `Material.m_color` ne l'est pas,
//! c'est celle du matériau. Un noir voulu (les deux à 0), un quasi-noir (« Wood_Walnut black », 7 7 7) ou
//! une apparence qui a une vraie couleur ne changent pas.
//!
//! ## Le style d'une surface sans matériau (DWG importée dans une famille)
//!
//! Un `GPolyMesh` d'un `MasterImportSymbol` (la DWG importée) a `m_materialID` et `m_interiorGStyleID` à −1 : rvt-rs le
//! résout au gris du viewport. Sa couleur est ailleurs : le `GGroup` du calque qui le porte a pour
//! `GInfo.m_categoryId` un `GStyleElem` (type 3 pour les styles que l'import crée, 1 pour celui de la catégorie d'un calque),
//! dont le `GStyle.m_materialElemId` est le matériau du calque, la règle des styles d'objet de Revit : une surface sans
//! matériau prend celui de sa (sous-)catégorie. Le `CategoryElem` du calque (« 0 » dans les deux DWG de `wadduwa.rvt`) n'a pas
//! de matériau propre : il ne fait que lister ses styles (`m_gstyleIds`).
//!
//! Dans les deux DWG de voitures de `wadduwa.rvt`, les 9 calques de la Peugeot qui portent des facettes et les 10 du Citroën ont
//! chacun un matériau distinct, et ce sont ceux qu'on attend : le calque de la carrosserie de la « Blue Car » (36,8 % des facettes) est bleu (apparence
//! 15 21 143), celui de la « Red Car » (40,0 %) rouge (130 0 0, et 155 0 0 pour 6,3 % de plus) ; les vitres, les pneus et le noir de
//! la calandre sont les mêmes dans les deux (la vitre : 15 15 18 à 30 % de transparence, des deux côtés). La couleur de
//! ligne du style (`GStyle.m_color`, avec `m_penNumber`) vaut 0 pour les 34 styles d'import des deux voitures : elle ne dit rien
//! de la couleur, et elle n'est pas utilisée.

use std::collections::BTreeMap;

use anyhow::Result;
use crate::native::Record;
use rvt::research::native_saved_materials::{RenderMaterial, Resolver as Rvt};
use serde_json::Value;

/// Le résolveur de rvt-rs, et la couleur d'ombrage de chaque matériau lu. Même interface que le sien.
#[derive(Debug)]
pub struct Resolver {
    inner: Rvt,
    /// `Material.m_color` de chaque élément matériau, en RVB 0..1.
    shading: BTreeMap<i64, [f64; 3]>,
    /// Le matériau (`GStyle.m_materialElemId`) de chaque `GStyleElem` qui en a un (plus grand que 0).
    style_materials: BTreeMap<i64, i64>,
}

impl Resolver {
    /// Le profil du viewport par défaut de rvt-rs : opaque, gris neutre sans matériau.
    pub fn default_viewport_profile() -> Self {
        Self { inner: Rvt::default_viewport_profile(), shading: BTreeMap::new(), style_materials: BTreeMap::new() }
    }

    /// Un enregistrement d'élément (canal 102) : rvt-rs le range, et on retient la couleur d'ombrage des
    /// éléments matériau.
    pub fn ingest(&mut self, record: &Record) -> Result<()> {
        self.inner.ingest(record)?;
        if record.channel == 102 && record.class_name.as_deref() == Some("MaterialElem") {
            let color = record.graph.as_ref().and_then(|graph| graph.objects.iter().find(|object| object.class_name == "Material")).and_then(|object| object.fields.get("m_color")).and_then(unpack);
            if let Some(color) = color {
                self.shading.insert(record.identity.element_id as i64, color);
            }
        }
        if record.channel == 102 && record.class_name.as_deref() == Some("GStyleElem") {
            let material = record.graph.as_ref().and_then(|graph| graph.objects.iter().find(|object| object.class_name == "GStyle")).and_then(|object| object.fields.get("m_materialElemId")).and_then(identifier).filter(|id| *id > 0);
            if let Some(material) = material {
                self.style_materials.insert(record.identity.element_id as i64, material);
            }
        }
        Ok(())
    }

    /// Le matériau d'une primitive : celui de rvt-rs, avec sa couleur rattrapée (voir `rescued`).
    pub fn resolve(&self, owner_id: u64, source_owner_id: Option<u64>, face_tag: i64, render_style_id: i64, explicit_material_id: Option<i64>) -> Option<RenderMaterial> {
        let mut material = self.inner.resolve(owner_id, source_owner_id, face_tag, render_style_id, explicit_material_id)?;
        let shading = material.material_id.and_then(|id| self.shading.get(&id)).copied();
        material.base_color = rescued(material.base_color, shading);
        Some(material)
    }
}

impl Resolver {
    /// Le matériau d'une primitive qui n'a ni matériau ni style de rendu propres (un `GPolyMesh` à `m_materialID` et
    /// `m_interiorGStyleID` à −1), quand le `GStyleElem` `layer` de son calque a un matériau : celui-ci, par la même règle que le
    /// style de rendu d'une face (`resolve`). Sans ce matériau de calque (`layer` à −1, style inconnu ou sans matériau), ou quand
    /// la primitive a son propre matériau ou son propre style, c'est `resolve`, rien ne change.
    pub fn resolve_in_layer(&self, owner_id: u64, source_owner_id: Option<u64>, face_tag: i64, render_style_id: i64, explicit_material_id: Option<i64>, layer: i64) -> Option<RenderMaterial> {
        self.resolve(owner_id, source_owner_id, face_tag, self.style_in_layer(render_style_id, explicit_material_id, layer), explicit_material_id)
    }

    /// Le style de rendu à résoudre pour une primitive : le style du calque (`layer`) quand la primitive n'a ni matériau ni style
    /// de rendu propres et que ce style a un matériau, sinon son propre style (`render_style_id`).
    fn style_in_layer(&self, render_style_id: i64, explicit_material_id: Option<i64>, layer: i64) -> i64 {
        let own = explicit_material_id.is_some_and(|id| id > 0) || render_style_id >= 0;
        if !own && self.style_materials.contains_key(&layer) { layer } else { render_style_id }
    }
}

/// Un identifiant sérialisé : un entier, ou un entier enveloppé dans `m_id` puis `m_id64`.
fn identifier(value: &Value) -> Option<i64> {
    value.as_i64().or_else(|| ["m_id", "m_id64"].iter().find_map(|key| value.get(*key)).and_then(identifier))
}

/// La couleur résolue (RVB 0..1 et opacité), ou, si elle est exactement noire et que le matériau a une
/// couleur d'ombrage qui ne l'est pas, cette couleur-ci. L'opacité ne change jamais.
fn rescued(color: [f64; 4], shading: Option<[f64; 3]>) -> [f64; 4] {
    match shading {
        Some(shading) if color[..3].iter().all(|c| *c == 0.0) && shading.iter().any(|c| *c > 0.0) => [shading[0], shading[1], shading[2], color[3]],
        _ => color,
    }
}

/// Une couleur que Revit enregistre en un entier (rouge dans l'octet de poids faible, comme rvt-rs).
fn unpack(value: &Value) -> Option<[f64; 3]> {
    let packed = value.as_u64().filter(|packed| *packed <= 0xff_ffff)?;
    Some([(packed & 255) as f64 / 255.0, ((packed >> 8) & 255) as f64 / 255.0, ((packed >> 16) & 255) as f64 / 255.0])
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLACK: [f64; 4] = [0.0, 0.0, 0.0, 1.0];

    /// « White » de RE1-Architecture : l'apparence « Generic(1) » a une couleur 0, le matériau 0xFFFFFF.
    #[test]
    fn une_couleur_d_apparence_jamais_calculee_cede_a_la_couleur_d_ombrage() {
        assert_eq!(rescued(BLACK, Some([1.0, 1.0, 1.0])), [1.0, 1.0, 1.0, 1.0]);
        // L'opacité est celle de l'apparence, pas celle de l'ombrage.
        assert_eq!(rescued([0.0, 0.0, 0.0, 0.4], Some([0.5, 0.25, 0.125])), [0.5, 0.25, 0.125, 0.4]);
    }

    #[test]
    fn un_noir_voulu_ou_une_vraie_couleur_ne_changent_pas() {
        // Matériau sans ombrage lu, ou lui-même noir : le noir est voulu.
        assert_eq!(rescued(BLACK, None), BLACK);
        assert_eq!(rescued(BLACK, Some([0.0, 0.0, 0.0])), BLACK);
        // « Wood_Walnut black » (7 7 7) : presque noir, mais une couleur.
        let walnut = [7.0 / 255.0, 7.0 / 255.0, 7.0 / 255.0, 1.0];
        assert_eq!(rescued(walnut, Some([1.0, 1.0, 1.0])), walnut);
        // L'apparence a une couleur qui diffère de l'ombrage (« Grey » : 221 contre 219) : celle de l'apparence.
        let grey = [221.0 / 255.0, 221.0 / 255.0, 221.0 / 255.0, 1.0];
        assert_eq!(rescued(grey, Some([219.0 / 255.0, 219.0 / 255.0, 219.0 / 255.0])), grey);
    }

    /// Le calque d'un `GPolyMesh` d'import (`GStyleElem` 750250, matériau 749404 : celui de « Peugeot 208 2 » dans `wadduwa.rvt`) ne sert
    /// que quand la primitive n'a ni matériau ni style propres et que le style du calque a un matériau.
    #[test]
    fn le_style_du_calque_ne_sert_qu_a_une_primitive_sans_matiere_ni_style() {
        let mut resolver = Resolver::default_viewport_profile();
        resolver.style_materials.insert(750250, 749404);
        // Ni matériau ni style de rendu (−1, −1) : le style du calque.
        assert_eq!(resolver.style_in_layer(-1, None, 750250), 750250);
        // Un matériau explicite, ou un style de rendu propre, passent d'abord.
        assert_eq!(resolver.style_in_layer(-1, Some(534), 750250), -1);
        assert_eq!(resolver.style_in_layer(612, None, 750250), 612);
        // Un matériau explicite non positif (−1 : « aucun ») n'est pas un matériau.
        assert_eq!(resolver.style_in_layer(-1, Some(-1), 750250), 750250);
        // Pas de calque (−1), calque inconnu ou sans matériau (750251 n'a pas été retenu) : rien ne change, le gris du viewport reste.
        assert_eq!(resolver.style_in_layer(-1, None, -1), -1);
        assert_eq!(resolver.style_in_layer(-1, None, 750251), -1);
    }

    #[test]
    fn la_couleur_empaquetee_se_lit_comme_rvt_rs() {
        assert_eq!(unpack(&Value::from(0xff_ffffu64)), Some([1.0, 1.0, 1.0]));
        assert_eq!(unpack(&Value::from(14_145_495u64)), Some([215.0 / 255.0; 3])); // « Light Grey »
        assert_eq!(unpack(&Value::from(0x0000ffu64)), Some([1.0, 0.0, 0.0]));
        assert_eq!(unpack(&Value::from(0x1_000_000u64)), None);
        assert_eq!(unpack(&Value::from("blanc")), None);
    }
}
