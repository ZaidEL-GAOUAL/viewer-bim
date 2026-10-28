//! Position du projet sur Terre, lue dans les enregistrements natifs de Revit 2023 à 2027.
//!
//! Revit garde l'emplacement du site (`GeoSite` : latitude et longitude en radians, altitude en pieds,
//! nom du lieu) et, pour chaque « emplacement de projet » (`GeoLocation`), une transformation qui place
//! ce site dans le projet. L'élément `ActiveGeoLocationTrackingElement` désigne l'emplacement actif. Un
//! fichier dont l'emplacement n'a jamais été choisi garde celui du gabarit (Waltham, Massachusetts) et un
//! nom de lieu vide : on ne le recopie pas.
//!
//! **Sens de la transformation.** `GeoLocation` est une instance dont le « symbole » est le `GeoSite`
//! (`InstanceInfo.m_symbolId`) : comme pour toute instance (c'est ainsi que la géométrie place les symboles de
//! famille, et ses formes tombent juste), `m_Trf` envoie les coordonnées du symbole dans celles du projet,
//! `p_projet = M · p_site + m_or`, la matrice lue par lignes, la translation en pieds. Le repère du site est
//! celui des coordonnées partagées : X vers l'est, Y vers le nord vrai, Z vers le haut. Donc :
//! - le nord vrai, vu dans le projet, est l'image de l'axe Y du site : la **colonne 1** de `M` ;
//! - le point du projet qui est à la latitude et à la longitude du site, l'origine du site, est `m_or`.
//!
//! Ce que les fichiers d'essai en disent. Dans les trois DynamoSample (2023, 2024, 2025), l'emplacement
//! « Project » (`M` = identité) a pour translation exactement la position, dans le projet, du point de relevé
//! (`BasePoint` de type 0, origine des coordonnées partagées) : l'origine du site est bien à `m_or` dans le
//! projet, ce que dit `p_projet = M · p_site + m_or` ; dans le sens inverse, ce point de relevé serait à 2 × sa
//! position, non à zéro. C'est aussi la seule maquette dont l'emplacement actif (« Internal ») a une rotation
//! (37,0°) et une translation (89,08 pi, 10,14 pi) : le test `dynamo_sample_2024` de `tests/properties.rs`
//! les relit. Dans tous les autres fichiers d'essai, `M` est l'identité et `m_or` est nul.
//! `rvt-rs` ne peut pas arbitrer : son export IFC écrit un `IfcSite` sans position ni nord vrai.

use super::native::{Retained, element_id};
use crate::catalog::units::FOOT;
use serde_json::Value;
use std::collections::HashMap;

/// Le géoréférencement du contrat (`docs/contrat-metadonnees.md`, § « Position sur Terre »).
#[derive(Debug, Clone, PartialEq)]
pub struct Georeference {
    /// Degrés décimaux, WGS 84.
    pub latitude: f64,
    pub longitude: f64,
    /// Altitude de l'origine du site, en mètres au-dessus du niveau de la mer.
    pub elevation: f64,
    /// L'origine du site (le point qui est à cette latitude et à cette longitude) dans le repère du projet,
    /// en mètres, Z vers le haut, comme le contrat (`origin`) : le repère de Revit, converti du pied au mètre.
    pub origin: [f64; 3],
    /// Direction du nord vrai dans le plan du projet (X vers l'est du projet, Y vers son nord).
    pub true_north: [f64; 2],
    /// Nom du lieu donné à Revit.
    pub place: String,
}

/// Lit l'emplacement actif du projet dans les enregistrements que la lecture des éléments a gardés ;
/// `None` s'il manque ou s'il est celui du gabarit.
pub fn read(retained: &Retained) -> Option<Georeference> {
    // emplacement → (site, matrice 3x3, translation en pieds)
    let mut locations: HashMap<i64, (i64, [[f64; 3]; 3], [f64; 3])> = HashMap::new();
    // site → (latitude, longitude, altitude en pieds, lieu)
    let mut sites: HashMap<i64, (f64, f64, f64, String)> = HashMap::new();

    // Un seul élément de ce genre par document ; à défaut, le plus récent (identifiant le plus grand).
    let active = retained.site_graphs("ActiveGeoLocationTrackingElement").max_by_key(|(id, _)| *id).and_then(|(_, graph)| graph.objects.first()?.fields.get("m_activeGeoLocationId").and_then(element_id));

    for (id, graph) in retained.site_graphs("GeoSite") {
        let Some(root) = graph.objects.first() else { continue };
        let fields = &root.fields;
        let number = |key: &str| fields.get(key).and_then(Value::as_f64);
        if let (Some(lat), Some(lon)) = (number("m_dLatitude"), number("m_dLongitude")) {
            let place = fields.get("m_placeName").and_then(Value::as_str).unwrap_or("").to_string();
            sites.insert(id as i64, (lat, lon, number("m_dElevation").unwrap_or(0.0), place));
        }
    }
    for (id, graph) in retained.site_graphs("GeoLocation") {
        let info = graph.objects.iter().find(|o| o.class_name == "InstanceInfo");
        let site = info.and_then(|o| o.fields.get("m_symbolId")).and_then(element_id);
        let rows = info.and_then(|o| o.fields.pointer("/m_Trf/m_3x3")).and_then(Value::as_array);
        let translation = info.and_then(|o| o.fields.pointer("/m_Trf/m_or")).and_then(Value::as_array);
        if let (Some(site), Some(rows)) = (site, rows) {
            let mut matrix = [[0.0; 3]; 3];
            for (i, row) in rows.iter().take(3).enumerate() {
                for (j, value) in row.as_array().into_iter().flatten().take(3).enumerate() {
                    matrix[i][j] = value.as_f64().unwrap_or(0.0);
                }
            }
            let mut origin = [0.0; 3];
            for (i, value) in translation.into_iter().flatten().take(3).enumerate() {
                origin[i] = value.as_f64().filter(|x| x.is_finite()).unwrap_or(0.0);
            }
            locations.insert(id as i64, (site, matrix, origin));
        }
    }

    let (site, matrix, origin_feet) = locations.get(&active?)?;
    let (latitude, longitude, elevation_ft, place) = sites.get(site)?;
    if place.trim().is_empty() {
        return None;
    }
    // Le nord du site (axe Y de son repère) vu dans le repère du projet : colonne 1 de la matrice.
    let (x, y) = (matrix[0][1], matrix[1][1]);
    let length = x.hypot(y);
    let true_north = if length > 1e-9 { [x / length, y / length] } else { [0.0, 1.0] };
    let origin = [origin_feet[0] * FOOT, origin_feet[1] * FOOT, origin_feet[2] * FOOT];
    Some(Georeference { latitude: latitude.to_degrees(), longitude: longitude.to_degrees(), elevation: elevation_ft * FOOT, origin, true_north, place: place.clone() })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rvt::research::native_parameters::ObjectGraph;
    use serde_json::json;

    fn graph(objects: Vec<(&str, Value)>) -> ObjectGraph {
        let objects: Vec<Value> = objects
            .into_iter()
            .enumerate()
            .map(|(i, (class, fields))| json!({"class_tag": 0, "class_name": class, "token": i, "start": 0, "fields_end": 0, "fields": fields}))
            .collect();
        serde_json::from_value(json!({"consumed_bytes": 0, "objects": objects, "edges": []})).expect("graphe")
    }

    fn id(n: i64) -> Value {
        json!({"m_id": {"m_id64": n}})
    }

    /// Un `GeoSite` : latitude et longitude en radians, altitude en pieds, nom du lieu.
    fn site(retained: &mut Retained, element: u64, latitude: f64, longitude: f64, elevation_ft: f64, place: &str) {
        retained.keep_site_graph(element, graph(vec![("GeoSite", json!({"m_dLatitude": latitude.to_radians(), "m_dLongitude": longitude.to_radians(), "m_dElevation": elevation_ft, "m_placeName": place}))]));
    }

    /// Un `GeoLocation` : une instance dont le symbole est le site, de matrice `rows` (lues par lignes) et de translation
    /// `origin` en pieds.
    fn location(retained: &mut Retained, element: u64, of_site: i64, rows: [[f64; 3]; 3], origin: [f64; 3]) {
        retained.keep_site_graph(
            element,
            graph(vec![("GeoLocation", json!({"m_name": "Internal"})), ("InstanceInfo", json!({"m_symbolId": id(of_site), "m_Trf": {"m_3x3": rows, "m_or": origin}}))]),
        );
    }

    fn active(retained: &mut Retained, element: u64, location: i64) {
        retained.keep_site_graph(element, graph(vec![("ActiveGeoLocationTrackingElement", json!({"m_activeGeoLocationId": id(location)}))]));
    }

    const IDENTITY: [[f64; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

    fn close(found: f64, expected: f64) {
        assert!((found - expected).abs() < 1e-9, "{found} au lieu de {expected}");
    }

    #[test]
    fn l_origine_du_site_est_la_translation_en_pieds_convertie_en_metres() {
        let mut retained = Retained::default();
        site(&mut retained, 10, 42.213, -71.0335, 154.0, "Boston, MA");
        // Trois valeurs distinctes : une translation lue dans le désordre ou prise sur la matrice se verrait.
        location(&mut retained, 20, 10, IDENTITY, [100.0, 50.0, 10.0]);
        active(&mut retained, 30, 20);
        let geo = read(&retained).expect("emplacement actif");
        close(geo.origin[0], 100.0 * 0.3048);
        close(geo.origin[1], 50.0 * 0.3048);
        close(geo.origin[2], 10.0 * 0.3048);
        // Le site : radians en degrés, pieds en mètres, nom du lieu.
        close(geo.latitude, 42.213);
        close(geo.longitude, -71.0335);
        close(geo.elevation, 154.0 * 0.3048);
        assert_eq!(geo.place, "Boston, MA");
        // La matrice identité : le nord vrai est l'axe Y du projet.
        assert_eq!(geo.true_north, [0.0, 1.0]);
    }

    #[test]
    fn le_nord_vrai_est_la_colonne_1_de_la_matrice() {
        // L'emplacement des DynamoSample : une rotation de 37° dans le sens horaire. Lignes (0,7986 ; 0,6018 ; 0) et
        // (−0,6018 ; 0,7986 ; 0), translation (89,0779 ; 10,1405 ; 0).
        let (cos, sin) = (37f64.to_radians().cos(), 37f64.to_radians().sin());
        let mut retained = Retained::default();
        site(&mut retained, 10, 42.213, -71.0335, 154.0, "Boston, MA");
        location(&mut retained, 20, 10, [[cos, sin, 0.0], [-sin, cos, 0.0], [0.0, 0.0, 1.0]], [89.0779, 10.1405, 0.0]);
        active(&mut retained, 30, 20);
        let geo = read(&retained).expect("emplacement actif");
        // Colonne 1 : (m01, m11) = (sin, cos), vers l'est du projet et vers son nord. La ligne 1 (−sin, cos) en serait le
        // miroir (x < 0) ; la colonne 0 (cos, −sin) et la ligne 0 (cos, sin) donneraient d'autres directions.
        close(geo.true_north[0], sin);
        close(geo.true_north[1], cos);
        assert!(geo.true_north[0] > 0.0, "nord vrai vers l'est du projet");
        close(geo.true_north[0].atan2(geo.true_north[1]).to_degrees(), 37.0);
        // Et l'origine, au même niveau que le projet : 89,0779 pi et 10,1405 pi en mètres.
        close(geo.origin[0], 89.0779 * 0.3048);
        close(geo.origin[1], 10.1405 * 0.3048);
        close(geo.origin[2], 0.0);
    }

    #[test]
    fn le_signe_et_l_ordre_des_indices_se_lisent_sur_un_quart_de_tour() {
        // Une rotation de 90° dans le sens horaire (le nord vrai à l'est du projet) : lignes (0, 1, 0), (−1, 0, 0). Seule la
        // colonne 1, (1, 0), donne l'est ; la ligne 1, (−1, 0), donnerait l'ouest.
        let mut retained = Retained::default();
        site(&mut retained, 10, 45.0, 5.0, 0.0, "Lyon");
        location(&mut retained, 20, 10, [[0.0, 1.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 0.0, 1.0]], [0.0; 3]);
        active(&mut retained, 30, 20);
        let geo = read(&retained).expect("emplacement actif");
        assert_eq!(geo.true_north, [1.0, 0.0]);
        // Dans l'autre sens (le nord vrai à l'ouest), le signe change.
        let mut retained = Retained::default();
        site(&mut retained, 10, 45.0, 5.0, 0.0, "Lyon");
        location(&mut retained, 20, 10, [[0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]], [0.0; 3]);
        active(&mut retained, 30, 20);
        assert_eq!(read(&retained).expect("emplacement actif").true_north, [-1.0, 0.0]);
        // Une matrice qui n'est pas unitaire (échelle) : la direction est normalisée, jamais l'échelle.
        let mut retained = Retained::default();
        site(&mut retained, 10, 45.0, 5.0, 0.0, "Lyon");
        location(&mut retained, 20, 10, [[0.0, 3.0, 0.0], [-3.0, 0.0, 0.0], [0.0, 0.0, 1.0]], [0.0; 3]);
        active(&mut retained, 30, 20);
        assert_eq!(read(&retained).expect("emplacement actif").true_north, [1.0, 0.0]);
    }

    #[test]
    fn l_emplacement_actif_est_celui_que_l_element_de_suivi_designe() {
        let mut retained = Retained::default();
        site(&mut retained, 10, 42.213, -71.0335, 154.0, "Boston, MA");
        location(&mut retained, 20, 10, IDENTITY, [1.0, 2.0, 3.0]);
        location(&mut retained, 21, 10, IDENTITY, [10.0, 20.0, 30.0]);
        active(&mut retained, 30, 21);
        let geo = read(&retained).expect("emplacement actif");
        close(geo.origin[0], 10.0 * 0.3048);
        close(geo.origin[2], 30.0 * 0.3048);
        // Sans élément de suivi, ou désignant un emplacement absent : rien.
        let mut retained = Retained::default();
        site(&mut retained, 10, 42.213, -71.0335, 154.0, "Boston, MA");
        location(&mut retained, 20, 10, IDENTITY, [1.0, 2.0, 3.0]);
        assert!(read(&retained).is_none());
        active(&mut retained, 30, 99);
        assert!(read(&retained).is_none());
    }

    #[test]
    fn le_lieu_du_gabarit_n_est_pas_recopie() {
        // Un fichier dont l'emplacement n'a jamais été choisi garde celui du gabarit, sans nom de lieu.
        let mut retained = Retained::default();
        site(&mut retained, 10, 42.37, -71.24, 0.0, "  ");
        location(&mut retained, 20, 10, IDENTITY, [0.0; 3]);
        active(&mut retained, 30, 20);
        assert!(read(&retained).is_none());
        // Une matrice dégénérée (colonne 1 nulle) garde le nord du projet.
        let mut retained = Retained::default();
        site(&mut retained, 10, 42.37, -71.24, 0.0, "Waltham");
        location(&mut retained, 20, 10, [[1.0, 0.0, 0.0], [0.0, 0.0, 0.0], [0.0, 0.0, 1.0]], [0.0; 3]);
        active(&mut retained, 30, 20);
        assert_eq!(read(&retained).expect("emplacement").true_north, [0.0, 1.0]);
    }
}
