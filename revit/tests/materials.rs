//! Les couleurs des formes : celles des matériaux de Revit, sans noir qui n'en soit pas un.
//!
//! RE1-Architecture : « White » et « Light Grey » cochent « Utiliser l'apparence de rendu pour l'ombrage »
//! mais leurs éléments d'apparence (« Generic », « Generic(1) ») n'ont jamais eu de couleur calculée (0) : rvt-rs
//! en tirait du noir, et tout le mobilier (ElementId 352342, le canapé, 351456, le fauteuil…) sortait noir.
//! La couleur d'ombrage du matériau (`Material.m_color`, celle que l'export IFC de Revit écrit) la remplace
//! quand la couleur résolue est exactement noire (voir `geometry::materials`).
//!
//! À lancer avec `cargo test --release`. Les fichiers publics viennent de `npm run samples:revit` ; sans eux,
//! les essais qui en dépendent passent sans rien faire.

use std::collections::BTreeSet;
use std::path::PathBuf;

use revit::Context;
use revit::geometry::{self, Geometry};

fn sample(name: &str) -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("samples").join(name);
    if !path.exists() {
        eprintln!("{name} absent de revit/samples/ : essai ignoré");
        return None;
    }
    Some(path)
}

fn build(path: &PathBuf) -> Geometry {
    let bytes = std::fs::read(path).expect("fichier d'essai illisible");
    let mut file = rvt::RevitFile::open_bytes(bytes).expect("fichier Revit");
    let release = revit::native::release(&mut file);
    geometry::build(&mut file, &mut Context::new(release)).expect("géométrie")
}

/// Les couleurs (octets sRGB et alpha) des primitives de l'élément Revit `id`.
fn paints_of(geometry: &Geometry, id: u64) -> BTreeSet<[u8; 4]> {
    let element = geometry.element_ids.iter().position(|element| *element == id).unwrap_or_else(|| panic!("l'élément {id} n'est pas dessiné"));
    geometry.primitives.chunks_exact(6).filter(|row| row[0] as usize == element).map(|row| geometry.materials[row[5] as usize * 6..][..4].try_into().expect("quatre octets")).collect()
}

/// Les couleurs RVB de toutes les primitives.
fn all_paints(geometry: &Geometry) -> BTreeSet<[u8; 3]> {
    geometry.materials.chunks_exact(6).map(|row| [row[0], row[1], row[2]]).collect()
}

#[test]
fn le_mobilier_de_re1_architecture_a_la_couleur_de_son_materiau() {
    let Some(path) = sample("RE1-Architecture.rvt") else { return };
    let geometry = build(&path);
    // Le canapé (352342) et le fauteuil (351456) : « White », 0xFFFFFF.
    for id in [352342, 351456] {
        assert_eq!(paints_of(&geometry, id), BTreeSet::from([[255, 255, 255, 255]]), "couleurs de l'élément {id}");
    }
    // Aucune primitive du fichier n'est du noir pur : ni « White » ni « Light Grey » (0xD7D7D7).
    let paints = all_paints(&geometry);
    assert!(!paints.contains(&[0, 0, 0]), "du noir pur : {paints:?}");
    assert!(paints.contains(&[215, 215, 215]), "« Light Grey » : {paints:?}");
    // Les matériaux dont l'apparence avait une couleur ne bougent pas : gypse, bois de la porte, peinture.
    for color in [[249, 249, 249], [210, 159, 95], [118, 70, 51]] {
        assert!(paints.contains(&color), "{color:?} manque : {paints:?}");
    }
}

/// Un presque noir voulu reste tel quel (« Wood_Walnut black », 7 7 7), et il n'y a pas de noir pur.
#[test]
fn un_quasi_noir_voulu_n_est_pas_eclairci() {
    let Some(path) = sample("DynamoSample_2024.rvt") else { return };
    let paints = all_paints(&build(&path));
    assert!(paints.contains(&[7, 7, 7]), "« Wood_Walnut black » : {paints:?}");
    assert!(!paints.contains(&[0, 0, 0]), "du noir pur : {paints:?}");
}
