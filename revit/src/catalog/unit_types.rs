//! Les unités des paramètres de famille de Revit 2015 à 2020.
//!
//! Avant Revit 2021, la définition d'un paramètre décimal (`ParamDefValue`) ne porte pas de spec
//! (`m_specTypeId`, un `ForgeTypeId`) mais le numéro de la valeur de l'énumération `UnitType` de l'API de Revit
//! (`m_unitType` : 0 longueur, 1 surface, 3 angle…). Sans spec, la valeur (en unités internes de Revit : pieds,
//! kilogrammes, secondes…) resterait telle quelle, sans unité dans le nom de la propriété. Ce module donne, pour
//! chaque numéro dont la grandeur est connue de `units`, la spec que Revit 2022 et suivants lui donnent
//! (`SpecTypeId`), de sorte qu'un paramètre de famille se convertit comme celui d'un fichier récent.
//!
//! Établi sur trois sources, dans cet ordre de confiance :
//! 1. quinze numéros observés sur les octets : `SampleModel.rvt` (Revit 2017) et `DynamoSample_2023.rvt` sont le même
//!    modèle (mêmes identifiants d'élément, mêmes GlobalId IFC) enregistré par deux versions ; les 230 définitions décimales
//!    de paramètres de famille que les deux fichiers ont en commun (230 décimales sur 774 et 510 définitions) portent, dans l'ancien, `m_unitType` et, dans le
//!    nouveau, `m_specTypeId`, et chaque numéro a toujours la même spec (`PAIRS`) ;
//! 2. les valeurs de l'énumération `UnitType` de `RevitAPI.dll` (Revit 2021, 133 membres, de `UT_Length = 0` à
//!    `UT_Stationing = 132`) : les quinze numéros observés y portent exactement les noms que les specs donnent
//!    (12 = `UT_HVAC_Pressure`, 34 = `UT_Electrical_Apparent_Power`, 74 = `UT_Electrical_Wattage`, 86 =
//!    `UT_Electrical_Demand_Factor`…) ; l'énumération n'a jamais été que complétée à la fin, un numéro garde donc son sens
//!    dans les fichiers de toutes les versions ;
//! 3. la correspondance de nom que l'API de Revit 2022 documente de `UnitType.UT_X` à `SpecTypeId.X`.
//!
//! Ne sont retenus que les numéros dont la grandeur est connue de `units` (convertible ou sans dimension), plus
//! ceux que la source 1 a observés : les autres (conductivité thermique, poids, coût, ressorts…) resteraient telles
//! quelles de toute façon, sans unité dans le nom, et rien ne sert de leur donner une spec dont rien ne se sert.
//! Un numéro absent d'ici (`None`) laisse la valeur brute, sans suffixe : jamais un nombre présenté comme du SI
//! quand on ne sait pas ce qu'il vaut.

/// Les numéros observés sur les octets (source 1) et leur spec dans le fichier de 2023 (`autodesk.spec…-1.0.0`).
pub const PAIRS: [(i64, &str); 15] = [
    (0, "autodesk.spec.aec:length-1.0.0"),
    (1, "autodesk.spec.aec:area-1.0.0"),
    (3, "autodesk.spec.aec:angle-1.0.0"),
    (4, "autodesk.spec.aec:number-1.0.0"),
    (12, "autodesk.spec.aec.hvac:pressure-1.0.0"),
    (19, "autodesk.spec.aec.electrical:current-1.0.0"),
    (20, "autodesk.spec.aec.electrical:potential-1.0.0"),
    (24, "autodesk.spec.aec.electrical:power-1.0.0"),
    (26, "autodesk.spec.aec.structural:force-1.0.0"),
    (34, "autodesk.spec.aec.electrical:apparentPower-1.0.0"),
    (37, "autodesk.spec.aec.piping:flow-1.0.0"),
    (39, "autodesk.spec.aec.piping:pressure-1.0.0"),
    (43, "autodesk.spec.aec.piping:pipeSize-1.0.0"),
    (74, "autodesk.spec.aec.electrical:wattage-1.0.0"),
    (86, "autodesk.spec.aec.electrical:demandFactor-1.0.0"),
];

/// Les autres numéros (sources 2 et 3) : (numéro, nom dans l'énumération `UnitType`, spec). Même version « 1.0.0 » que
/// les couples observés ; seule la nature (`units::kind_of`) compte pour la conversion.
const NAMED: &[(i64, &str, &str)] = &[
    (2, "UT_Volume", "autodesk.spec.aec:volume-1.0.0"),
    (5, "UT_SheetLength", "autodesk.spec.aec:sheetLength-1.0.0"),
    (6, "UT_SiteAngle", "autodesk.spec.aec:siteAngle-1.0.0"),
    (7, "UT_HVAC_Density", "autodesk.spec.aec.hvac:density-1.0.0"),
    (9, "UT_HVAC_Friction", "autodesk.spec.aec.hvac:friction-1.0.0"),
    (10, "UT_HVAC_Power", "autodesk.spec.aec.hvac:power-1.0.0"),
    (11, "UT_HVAC_Power_Density", "autodesk.spec.aec.hvac:powerDensity-1.0.0"),
    (13, "UT_HVAC_Temperature", "autodesk.spec.aec.hvac:temperature-1.0.0"),
    (14, "UT_HVAC_Velocity", "autodesk.spec.aec.hvac:velocity-1.0.0"),
    (15, "UT_HVAC_Airflow", "autodesk.spec.aec.hvac:airFlow-1.0.0"),
    (16, "UT_HVAC_DuctSize", "autodesk.spec.aec.hvac:ductSize-1.0.0"),
    (18, "UT_HVAC_HeatGain", "autodesk.spec.aec.hvac:heatGain-1.0.0"),
    (21, "UT_Electrical_Frequency", "autodesk.spec.aec.electrical:frequency-1.0.0"),
    (22, "UT_Electrical_Illuminance", "autodesk.spec.aec.electrical:illuminance-1.0.0"),
    (23, "UT_Electrical_Luminous_Flux", "autodesk.spec.aec.electrical:luminousFlux-1.0.0"),
    (25, "UT_HVAC_Roughness", "autodesk.spec.aec.hvac:roughness-1.0.0"),
    (27, "UT_LinearForce", "autodesk.spec.aec.structural:linearForce-1.0.0"),
    (28, "UT_AreaForce", "autodesk.spec.aec.structural:areaForce-1.0.0"),
    (29, "UT_Moment", "autodesk.spec.aec.structural:moment-1.0.0"),
    (35, "UT_Electrical_Power_Density", "autodesk.spec.aec.electrical:powerDensity-1.0.0"),
    (36, "UT_Piping_Density", "autodesk.spec.aec.piping:density-1.0.0"),
    (38, "UT_Piping_Friction", "autodesk.spec.aec.piping:friction-1.0.0"),
    (40, "UT_Piping_Temperature", "autodesk.spec.aec.piping:temperature-1.0.0"),
    (41, "UT_Piping_Velocity", "autodesk.spec.aec.piping:velocity-1.0.0"),
    (42, "UT_Piping_Viscosity", "autodesk.spec.aec.piping:viscosity-1.0.0"),
    (44, "UT_Piping_Roughness", "autodesk.spec.aec.piping:roughness-1.0.0"),
    (45, "UT_Stress", "autodesk.spec.aec.structural:stress-1.0.0"),
    (48, "UT_LinearMoment", "autodesk.spec.aec.structural:linearMoment-1.0.0"),
    (55, "UT_Piping_Volume", "autodesk.spec.aec.piping:volume-1.0.0"),
    (56, "UT_HVAC_Viscosity", "autodesk.spec.aec.hvac:viscosity-1.0.0"),
    (58, "UT_HVAC_Airflow_Density", "autodesk.spec.aec.hvac:airFlowDensity-1.0.0"),
    (59, "UT_Slope", "autodesk.spec.aec:slope-1.0.0"),
    (60, "UT_HVAC_Cooling_Load", "autodesk.spec.aec.hvac:coolingLoad-1.0.0"),
    (61, "UT_HVAC_Cooling_Load_Divided_By_Area", "autodesk.spec.aec.hvac:coolingLoadDividedByArea-1.0.0"),
    (63, "UT_HVAC_Heating_Load", "autodesk.spec.aec.hvac:heatingLoad-1.0.0"),
    (64, "UT_HVAC_Heating_Load_Divided_By_Area", "autodesk.spec.aec.hvac:heatingLoadDividedByArea-1.0.0"),
    (69, "UT_WireSize", "autodesk.spec.aec.electrical:wireDiameter-1.0.0"),
    (70, "UT_HVAC_Slope", "autodesk.spec.aec.hvac:slope-1.0.0"),
    (71, "UT_Piping_Slope", "autodesk.spec.aec.piping:slope-1.0.0"),
    (73, "UT_Electrical_Efficacy", "autodesk.spec.aec.electrical:efficacy-1.0.0"),
    (75, "UT_Color_Temperature", "autodesk.spec.aec.electrical:colorTemperature-1.0.0"),
    (76, "UT_DecSheetLength", "autodesk.spec.aec:decimalSheetLength-1.0.0"),
    (77, "UT_Electrical_Luminous_Intensity", "autodesk.spec.aec.electrical:luminousIntensity-1.0.0"),
    (78, "UT_Electrical_Luminance", "autodesk.spec.aec.electrical:luminance-1.0.0"),
    (80, "UT_HVAC_Factor", "autodesk.spec.aec.hvac:factor-1.0.0"),
    (81, "UT_Electrical_Temperature", "autodesk.spec.aec.electrical:temperature-1.0.0"),
    (82, "UT_Electrical_CableTraySize", "autodesk.spec.aec.electrical:cableTraySize-1.0.0"),
    (83, "UT_Electrical_ConduitSize", "autodesk.spec.aec.electrical:conduitSize-1.0.0"),
    (84, "UT_Reinforcement_Volume", "autodesk.spec.aec.structural:reinforcementVolume-1.0.0"),
    (85, "UT_Reinforcement_Length", "autodesk.spec.aec.structural:reinforcementLength-1.0.0"),
    (87, "UT_HVAC_DuctInsulationThickness", "autodesk.spec.aec.hvac:ductInsulationThickness-1.0.0"),
    (88, "UT_HVAC_DuctLiningThickness", "autodesk.spec.aec.hvac:ductLiningThickness-1.0.0"),
    (89, "UT_PipeInsulationThickness", "autodesk.spec.aec.piping:pipeInsulationThickness-1.0.0"),
    (92, "UT_Acceleration", "autodesk.spec.aec.structural:acceleration-1.0.0"),
    (93, "UT_Bar_Diameter", "autodesk.spec.aec.structural:barDiameter-1.0.0"),
    (94, "UT_Crack_Width", "autodesk.spec.aec.structural:crackWidth-1.0.0"),
    (95, "UT_Displacement_Deflection", "autodesk.spec.aec.structural:displacement-1.0.0"),
    (96, "UT_Energy", "autodesk.spec.aec.structural:energy-1.0.0"),
    (97, "UT_Structural_Frequency", "autodesk.spec.aec.structural:frequency-1.0.0"),
    (98, "UT_Mass", "autodesk.spec.aec.structural:mass-1.0.0"),
    (99, "UT_Mass_per_Unit_Length", "autodesk.spec.aec.structural:massPerUnitLength-1.0.0"),
    (100, "UT_Moment_of_Inertia", "autodesk.spec.aec.structural:momentOfInertia-1.0.0"),
    (102, "UT_Period", "autodesk.spec.aec.structural:period-1.0.0"),
    (103, "UT_Pulsation", "autodesk.spec.aec.structural:pulsation-1.0.0"),
    (104, "UT_Reinforcement_Area", "autodesk.spec.aec.structural:reinforcementArea-1.0.0"),
    (106, "UT_Reinforcement_Cover", "autodesk.spec.aec.structural:reinforcementCover-1.0.0"),
    (107, "UT_Reinforcement_Spacing", "autodesk.spec.aec.structural:reinforcementSpacing-1.0.0"),
    (108, "UT_Rotation", "autodesk.spec.aec.structural:rotation-1.0.0"),
    (109, "UT_Section_Area", "autodesk.spec.aec.structural:sectionArea-1.0.0"),
    (110, "UT_Section_Dimension", "autodesk.spec.aec.structural:sectionDimension-1.0.0"),
    (111, "UT_Section_Modulus", "autodesk.spec.aec.structural:sectionModulus-1.0.0"),
    (113, "UT_Structural_Velocity", "autodesk.spec.aec.structural:velocity-1.0.0"),
    (122, "UT_MassDensity", "autodesk.spec.aec:massDensity-1.0.0"),
    (123, "UT_MassPerUnitArea", "autodesk.spec.aec.structural:massPerUnitArea-1.0.0"),
    (124, "UT_Pipe_Dimension", "autodesk.spec.aec.piping:pipeDimension-1.0.0"),
    (125, "UT_PipeMass", "autodesk.spec.aec.piping:mass-1.0.0"),
    (126, "UT_PipeMassPerUnitLength", "autodesk.spec.aec.piping:pipeMassPerUnitLength-1.0.0"),
    (127, "UT_HVAC_TemperatureDifference", "autodesk.spec.aec.hvac:temperatureDifference-1.0.0"),
    (128, "UT_Piping_TemperatureDifference", "autodesk.spec.aec.piping:temperatureDifference-1.0.0"),
    (129, "UT_Electrical_TemperatureDifference", "autodesk.spec.aec.electrical:temperatureDifference-1.0.0"),
    (130, "UT_TimeInterval", "autodesk.spec.aec:time-1.0.0"),
    (131, "UT_Speed", "autodesk.spec.aec:speed-1.0.0"),
    (132, "UT_Stationing", "autodesk.spec.aec.infrastructure:stationing-1.0.0"),
];

/// La spec que Revit 2022 et suivants donnent à la valeur `unit_type` de l'ancienne énumération `UnitType`, ou
/// `None` si on ne la connaît pas (ou si rien ne s'en servirait : voir l'en-tête).
pub fn spec_of(unit_type: i64) -> Option<&'static str> {
    PAIRS.iter().find(|(number, _)| *number == unit_type).map(|(_, spec)| *spec).or_else(|| NAMED.iter().find(|(number, _, _)| *number == unit_type).map(|(_, _, spec)| *spec))
}

/// Tous les numéros qui ont une spec, en ordre croissant.
pub fn mapped() -> Vec<i64> {
    let mut numbers: Vec<i64> = PAIRS.iter().map(|(number, _)| *number).chain(NAMED.iter().map(|(number, _, _)| *number)).collect();
    numbers.sort_unstable();
    numbers
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::units::{self, FOOT, Spec};

    #[test]
    fn les_quinze_couples_observes_sont_ceux_du_fichier_de_2023() {
        for (number, spec) in PAIRS {
            assert_eq!(spec_of(number), Some(spec));
        }
        // La liste de `units-pairs` : 0 longueur, 1 surface, 3 angle, 4 nombre, 12 pression CVC, 19 courant, 20 tension,
        // 24 puissance, 26 force, 34 puissance apparente, 37 débit, 39 pression de tuyauterie, 43 diamètre, 74 wattage,
        // 86 facteur de demande.
        let numbers: Vec<i64> = PAIRS.iter().map(|(number, _)| *number).collect();
        assert_eq!(numbers, vec![0, 1, 3, 4, 12, 19, 20, 24, 26, 34, 37, 39, 43, 74, 86]);
    }

    #[test]
    fn les_numeros_sont_uniques_et_leurs_specs_aussi_pour_la_meme_version() {
        let numbers = mapped();
        let mut sorted = numbers.clone();
        sorted.dedup();
        assert_eq!(numbers, sorted, "numéro en double");
        for number in &numbers {
            let spec = spec_of(*number).expect("numéro mappé");
            assert!(spec.starts_with("autodesk.spec") && spec.ends_with("-1.0.0"), "{number} : {spec}");
        }
        // Le nom que `UnitType` donne au numéro et la nature de la spec se répondent : le préfixe de discipline du nom
        // (HVAC, Piping, Electrical) est l'espace de noms de la spec.
        for (number, name, spec) in NAMED {
            for (prefix, namespace) in [("UT_HVAC_", ".hvac:"), ("UT_Piping_", ".piping:"), ("UT_Electrical_", ".electrical:")] {
                if name.starts_with(prefix) {
                    assert!(spec.contains(namespace), "{number} {name} : {spec}");
                }
            }
        }
    }

    #[test]
    fn des_numeros_inconnus_n_ont_pas_de_spec() {
        // -2 et -1 : indéfini et personnalisé ; 8, 17 et 30 à 33 : grandeurs sans unité établie ; au-delà de 132 : plus récent.
        for number in [-2, -1, 8, 17, 30, 31, 32, 33, 46, 47, 90, 91, 101, 112, 114, 115, 116, 117, 133, 1000, i64::MAX, i64::MIN] {
            assert_eq!(spec_of(number), None, "{number}");
        }
    }

    /// Ce que chaque numéro donne d'une valeur enregistrée de 1 : (suffixe, valeur SI), calculé à la main à partir
    /// des unités internes (pied 0,3048 m, kilogramme, seconde, kelvin, ampère, candela).
    fn expected(number: i64) -> Option<(&'static str, f64)> {
        let (f1, f2, f3) = (FOOT, FOOT * FOOT, FOOT * FOOT * FOOT);
        Some(match number {
            // Longueurs.
            0 | 5 | 16 | 25 | 43 | 44 | 69 | 76 | 82 | 83 | 85 | 87 | 88 | 89 | 93 | 94 | 95 | 106 | 107 | 110 | 124 | 132 => (" (m)", f1),
            // Surfaces, volumes, angles.
            1 | 104 | 109 => (" (m²)", f2),
            2 | 55 | 84 => (" (m³)", f3),
            3 | 6 | 108 => (" (°)", 180.0 / std::f64::consts::PI),
            // Sans dimension.
            4 | 80 | 86 => ("", 1.0),
            // Fluides.
            15 | 37 => (" (L/s)", 1000.0 * f3),
            58 => (" (L/(s·m²))", 1000.0 * f1),
            14 | 41 | 113 | 131 => (" (m/s)", f1),
            12 | 39 | 45 => (" (Pa)", 1.0 / f1),
            9 | 38 => (" (Pa/m)", 1.0 / f2),
            42 | 56 => (" (Pa·s)", 1.0 / f1),
            7 | 36 | 122 => (" (kg/m³)", 1.0 / f3),
            59 | 70 | 71 => (" (%)", 100.0),
            // Températures.
            13 | 40 | 81 => (" (°C)", 1.0 - 273.15),
            127 | 128 | 129 => (" (K)", 1.0),
            75 => (" (K)", 1.0),
            // Électricité et énergie.
            10 | 18 | 24 | 60 | 63 => (" (W)", f2),
            34 => (" (VA)", f2),
            11 | 35 | 61 | 64 => (" (W/m²)", 1.0),
            20 => (" (V)", f2),
            19 => (" (A)", 1.0),
            21 | 97 => (" (Hz)", 1.0),
            22 => (" (lx)", 1.0 / f2),
            78 => (" (cd/m²)", 1.0 / f2),
            23 => (" (lm)", 1.0),
            77 => (" (cd)", 1.0),
            73 => (" (lm/W)", 1.0 / f2),
            96 => (" (J)", f2),
            // Masses et efforts.
            98 | 125 => (" (kg)", 1.0),
            99 | 126 => (" (kg/m)", 1.0 / f1),
            123 => (" (kg/m²)", 1.0 / f2),
            26 | 48 => (" (N)", f1),
            27 => (" (N/m)", 1.0),
            28 => (" (N/m²)", 1.0 / f1),
            29 => (" (N·m)", f2),
            92 => (" (m/s²)", f1),
            100 => (" (m⁴)", f2 * f2),
            111 => (" (m³)", f3),
            102 | 130 => (" (s)", 1.0),
            103 => (" (rad/s)", 1.0),
            _ => return None,
        })
    }

    /// Chaque numéro mappé : sa spec est une grandeur connue de `units` (convertible, ou sans dimension), et la valeur
    /// enregistrée de 1 se convertit comme le calcul à la main de `expected`.
    #[test]
    fn chaque_numero_mappe_se_convertit_comme_calcule_a_la_main() {
        let mut seen = 0;
        for number in mapped() {
            let spec = spec_of(number).expect("spec");
            // Le wattage, observé mais de grandeur inconnue de `units`, reste tel quel.
            if number == 74 {
                assert_eq!(units::of_spec(spec), Spec::Unknown);
                continue;
            }
            let (suffix, value) = expected(number).unwrap_or_else(|| panic!("{number} ({spec}) : conversion non vérifiée"));
            match units::of_spec(spec) {
                Spec::Convert(unit) => {
                    assert_eq!(unit.suffix, suffix, "{number} {spec}");
                    let found = unit.convert(1.0);
                    assert!((found - value).abs() <= value.abs().max(1.0) * 1e-12, "{number} {spec} : {found} au lieu de {value}");
                }
                Spec::Plain => assert_eq!((suffix, value), ("", 1.0), "{number} {spec}"),
                Spec::Unknown => panic!("{number} {spec} : grandeur inconnue de `units`, le numéro n'a rien à faire dans la table"),
            }
            seen += 1;
        }
        // Tous les numéros sauf le wattage ont été vérifiés (et `expected` n'a pas d'entrée en trop).
        assert_eq!(seen, mapped().len() - 1);
        assert_eq!((0..=140).filter(|number| expected(*number).is_some()).count(), seen, "entrées de `expected` sans numéro mappé");
    }

    /// Les valeurs de la maquette de 2017 que le fichier de 2023 écrit déjà en unités SI : 0,19685 pied de « Casement
    /// Depth (type) » vaut 0,06 m (`Casement Depth (m) (type) 0.06`).
    #[test]
    fn un_exemple_de_la_maquette_de_2017() {
        let Spec::Convert(unit) = units::of_spec(spec_of(0).expect("longueur")) else { panic!("longueur") };
        assert!((unit.convert(0.19685) - 0.06).abs() < 1e-5);
    }
}
