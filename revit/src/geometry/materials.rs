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
}

impl Resolver {
    /// Le profil du viewport par défaut de rvt-rs : opaque, gris neutre sans matériau.
    pub fn default_viewport_profile() -> Self {
        Self { inner: Rvt::default_viewport_profile(), shading: BTreeMap::new() }
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

    #[test]
    fn la_couleur_empaquetee_se_lit_comme_rvt_rs() {
        assert_eq!(unpack(&Value::from(0xff_ffffu64)), Some([1.0, 1.0, 1.0]));
        assert_eq!(unpack(&Value::from(14_145_495u64)), Some([215.0 / 255.0; 3])); // « Light Grey »
        assert_eq!(unpack(&Value::from(0x0000ffu64)), Some([1.0, 0.0, 0.0]));
        assert_eq!(unpack(&Value::from(0x1_000_000u64)), None);
        assert_eq!(unpack(&Value::from("blanc")), None);
    }
}
