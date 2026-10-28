//! Les unités de Revit : de la valeur enregistrée dans le fichier (unités internes) à l'unité SI que
//! l'utilisateur d'un Revit en français voit par défaut.
//!
//! Revit enregistre toute valeur décimale dans un système cohérent dont les unités de base sont le pied
//! (longueur), la seconde, le kilogramme, le kelvin, l'ampère et la candela ; les unités dérivées s'en
//! construisent sans coefficient : un débit d'air est en pieds cubes par seconde, une pression en
//! kg/(pi·s²), une puissance en kg·pi²/s³, une tension en kg·pi²/(s³·A), un éclairement en lm/pi².
//! (rvt-rs donne les quatre premières dans les commentaires de son export IFC.) Seul le pied
//! diffère du SI : la valeur SI d'une grandeur dont la dimension porte la longueur à la puissance `n`
//! est donc la valeur enregistrée × 0,3048ⁿ ; le kilogramme, la seconde, le kelvin, l'ampère et la
//! candela passent tels quels. L'unité d'affichage (litre par seconde, pour un débit) n'est qu'un
//! facteur de plus. Une exception : le kelvin se convertit en degrés Celsius par un décalage.
//!
//! Chaque grandeur est désignée par sa « nature », la dernière partie sans version du `ForgeTypeId` de
//! sa spec (`autodesk.spec.aec.hvac:airFlow-2.0.0` : `airFlow`). Deux natures de même nom dans deux
//! disciplines (la pression de la gaine et du tuyau, la température de l'électricité et du CVC) ont la
//! même dimension : le nom suffit.
//!
//! Ne sont converties que les natures dont l'unité interne est certaine. Les autres (conductivité
//! thermique, coût, perméabilité, pourcentages…) restent telles quelles, sans unité dans le nom : le
//! nombre n'est jamais présenté comme du SI quand on ne sait pas ce qu'il vaut.

/// Un pied en mètres.
pub const FOOT: f64 = 0.3048;

/// Comment passer de la valeur enregistrée à l'unité d'affichage.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Unit {
    /// Suffixe du nom de la propriété, avec son espace : « (L/s) ».
    pub suffix: &'static str,
    /// Puissance de la longueur dans la dimension de la grandeur : le facteur du pied est `FOOT^longueur`.
    length: i32,
    /// Facteur de l'unité SI à l'unité d'affichage (1000 de m³/s à L/s).
    scale: f64,
    /// Décalage ajouté à la fin (le kelvin vaut 273,15 de plus que le degré Celsius).
    offset: f64,
}

impl Unit {
    const fn new(suffix: &'static str, length: i32) -> Self {
        Self { suffix, length, scale: 1.0, offset: 0.0 }
    }

    const fn scaled(suffix: &'static str, length: i32, scale: f64) -> Self {
        Self { suffix, length, scale, offset: 0.0 }
    }

    /// La valeur enregistrée, dans l'unité d'affichage.
    pub fn convert(&self, value: f64) -> f64 {
        value * FOOT.powi(self.length) * self.scale + self.offset
    }
}

/// Ce que dit la spec d'une valeur décimale.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Spec {
    /// Une grandeur dont on connaît l'unité interne : la valeur se convertit.
    Convert(Unit),
    /// Un nombre sans dimension (rapport, facteur) : la valeur est celle du fichier.
    Plain,
    /// Une grandeur dont l'unité interne n'est pas établie : la valeur reste telle quelle.
    Unknown,
}

/// La nature d'une spec : « autodesk.spec.aec.hvac:airFlow-2.0.0 » donne « airFlow ».
pub fn kind_of(spec: &str) -> &str {
    let name = spec.rsplit(':').next().unwrap_or(spec);
    match name.rfind('-') {
        Some(dash) if name[dash + 1..].chars().all(|c| c.is_ascii_digit() || c == '.') && dash + 1 < name.len() => &name[..dash],
        _ => name,
    }
}

/// Ce que dit la spec `spec` (le `ForgeTypeId` d'un paramètre, avec ou sans version).
pub fn of_spec(spec: &str) -> Spec {
    of_kind(kind_of(spec))
}

/// Ce que dit la nature `kind` (« airFlow »).
pub fn of_kind(kind: &str) -> Spec {
    // Les noms de la colonne de gauche sont ceux des `SpecTypeId` de Revit 2022 et suivants.
    let unit = match kind {
        // -- géométrie
        "length" | "distance" | "ductSize" | "pipeSize" | "conduitSize" | "cableTraySize" | "barDiameter" | "sectionDimension" | "reinforcementCover"
        | "reinforcementLength" | "reinforcementSpacing" | "ductInsulationThickness" | "ductLiningThickness" | "pipeInsulationThickness" | "pipeDimension"
        | "roughness" | "crackWidth" | "displacement" | "wireDiameter" | "sheetLength" | "decimalSheetLength" | "stationing" | "stationingInterval" => LENGTH,
        "area" | "sectionArea" | "reinforcementArea" => AREA,
        "volume" | "reinforcementVolume" => VOLUME,
        "angle" | "rotationAngle" | "siteAngle" | "rotation" => ANGLE,
        // -- fluides : pieds cubes par seconde, pieds par seconde, kg/(pi·s²)
        "airFlow" | "flow" => Unit::scaled(" (L/s)", 3, 1000.0),
        // Un débit par surface : pi³/s par pi², donc des pi/s.
        "airFlowDensity" => Unit::scaled(" (L/(s·m²))", 1, 1000.0),
        "velocity" | "speed" => Unit::new(" (m/s)", 1),
        "pressure" => Unit::new(" (Pa)", -1),
        "friction" => Unit::new(" (Pa/m)", -2),
        "viscosity" => Unit::new(" (Pa·s)", -1),
        "density" | "massDensity" => Unit::new(" (kg/m³)", -3),
        "massPerTime" => Unit::new(" (kg/s)", 0),
        // Le rapport de la montée à la course : 0,01 est une pente de 1 %.
        "slope" => Unit::scaled(" (%)", 0, 100.0),
        // -- température : kelvin
        "temperature" => Unit { suffix: " (°C)", length: 0, scale: 1.0, offset: -273.15 },
        "temperatureDifference" => Unit::new(" (K)", 0),
        "colorTemperature" => Unit::new(" (K)", 0),
        // -- électricité : kg·pi²/s³ (puissance), kg·pi²/(s³·A) (tension), lm/pi² (éclairement)
        "power" | "heatGain" | "coolingLoad" | "heatingLoad" => Unit::new(" (W)", 2),
        "apparentPower" => Unit::new(" (VA)", 2),
        "powerDensity" | "coolingLoadDividedByArea" | "heatingLoadDividedByArea" => Unit::new(" (W/m²)", 0),
        // Une surface par puissance : pi² par kg·pi²/s³ = s³/kg, soit des m²/W, sans facteur (le pied s'en va).
        "areaDividedByCoolingLoad" | "areaDividedByHeatingLoad" => Unit::new(" (m²/W)", 0),
        "potential" => Unit::new(" (V)", 2),
        "current" => Unit::new(" (A)", 0),
        "frequency" => Unit::new(" (Hz)", 0),
        "illuminance" => Unit::new(" (lx)", -2),
        "luminance" => Unit::new(" (cd/m²)", -2),
        "luminousFlux" => Unit::new(" (lm)", 0),
        "luminousIntensity" => Unit::new(" (cd)", 0),
        "efficacy" => Unit::new(" (lm/W)", -2),
        // -- masse et efforts : kg, kg·pi/s² (force), kg·pi²/s² (moment et énergie)
        "mass" => Unit::new(" (kg)", 0),
        "massPerUnitLength" | "pipeMassPerUnitLength" => Unit::new(" (kg/m)", -1),
        "massPerUnitArea" => Unit::new(" (kg/m²)", -2),
        "force" | "linearMoment" => Unit::new(" (N)", 1),
        "linearForce" => Unit::new(" (N/m)", 0),
        "areaForce" => Unit::new(" (N/m²)", -1),
        "stress" => Unit::new(" (Pa)", -1),
        "moment" => Unit::new(" (N·m)", 2),
        "energy" => Unit::new(" (J)", 2),
        "acceleration" => Unit::new(" (m/s²)", 1),
        "period" | "time" => Unit::new(" (s)", 0),
        "pulsation" | "angularSpeed" => Unit::new(" (rad/s)", 0),
        "momentOfInertia" => Unit::new(" (m⁴)", 4),
        "sectionModulus" => Unit::new(" (m³)", 3),
        // -- sans dimension
        "number" | "factor" | "demandFactor" => return Spec::Plain,
        _ => return Spec::Unknown,
    };
    Spec::Convert(unit)
}

// Les quatre unités des lettres du catalogue (`Quantity::Length`…), pour les paramètres intégrés dont aucune
// spec n'est enregistrée.
pub const LENGTH: Unit = Unit::new(" (m)", 1);
pub const AREA: Unit = Unit::new(" (m²)", 2);
pub const VOLUME: Unit = Unit::new(" (m³)", 3);
pub const ANGLE: Unit = Unit::scaled(" (°)", 0, 180.0 / std::f64::consts::PI);

#[cfg(test)]
mod tests {
    use super::*;

    /// Convertit `value` (unités internes de Revit) selon la spec et rend (suffixe, valeur).
    fn convert(spec: &str, value: f64) -> (&'static str, f64) {
        match of_spec(spec) {
            Spec::Convert(unit) => (unit.suffix, unit.convert(value)),
            other => panic!("{spec} : {other:?}"),
        }
    }

    /// Égal à 1e-9 près en valeur relative (les constantes ci-dessous sont écrites à la main, à dix chiffres).
    fn is(spec: &str, value: f64, suffix: &str, expected: f64) {
        let (found_suffix, found) = convert(spec, value);
        assert_eq!(found_suffix, suffix, "{spec} : suffixe");
        let error = (found - expected).abs() / expected.abs().max(1e-300);
        assert!(error < 1e-9, "{spec} {value} → {found} {suffix}, attendu {expected}");
    }

    #[test]
    fn la_nature_d_une_spec() {
        assert_eq!(kind_of("autodesk.spec.aec.hvac:airFlow-2.0.0"), "airFlow");
        assert_eq!(kind_of("autodesk.spec.aec.electrical:potential-1.0.0"), "potential");
        assert_eq!(kind_of("autodesk.spec.aec:length-2.0.1"), "length");
        assert_eq!(kind_of("autodesk.spec.aec.hvac:airFlow"), "airFlow");
        assert_eq!(kind_of("airFlow"), "airFlow");
        assert_eq!(of_spec("autodesk.spec.aec.hvac:airFlow-2.0.0"), of_spec("autodesk.spec.aec.hvac:airFlow-1.0.0"));
    }

    // Chaque essai donne une valeur enregistrée d'un pied cubique, d'un pied ou d'une unité interne, et la
    // valeur SI calculée à la main : pi = 0,3048 m, pi² = 0,09290304 m², pi³ = 0,028316846592 m³.
    #[test]
    fn la_geometrie() {
        is("autodesk.spec.aec:length-2.0.0", 1.0, " (m)", 0.3048);
        is("autodesk.spec.aec.hvac:ductSize-2.0.0", 2.0, " (m)", 0.6096);
        is("autodesk.spec.aec:area-2.0.0", 1.0, " (m²)", 0.09290304);
        is("autodesk.spec.aec:volume-2.0.0", 1.0, " (m³)", 0.028316846592);
        is("autodesk.spec.aec:angle-2.0.0", std::f64::consts::PI, " (°)", 180.0);
        is("autodesk.spec.aec:angle-2.0.0", std::f64::consts::FRAC_PI_2, " (°)", 90.0);
        is("autodesk.spec.aec.structural:reinforcementArea-2.0.0", 1.0, " (m²)", 0.09290304);
    }

    #[test]
    fn les_debits_et_les_vitesses() {
        // 1 pi³/s = 0,028316846592 m³/s = 28,316846592 L/s ; 500 pi³/min (8,3333 pi³/s) = 235,97372 L/s.
        is("autodesk.spec.aec.hvac:airFlow-2.0.0", 1.0, " (L/s)", 28.316846592);
        is("autodesk.spec.aec.piping:flow-2.0.0", 1.0, " (L/s)", 28.316846592);
        is("autodesk.spec.aec.hvac:airFlow-1.0.0", 25.0 / 3.0, " (L/s)", 235.97372160);
        // 1 pi/s (un pi³/s par pi²) = 0,3048 m³/s par m² = 304,8 L/(s·m²).
        is("autodesk.spec.aec.hvac:airFlowDensity-2.0.0", 1.0, " (L/(s·m²))", 304.8);
        // 1 pi/s = 0,3048 m/s.
        is("autodesk.spec.aec.hvac:velocity-2.0.0", 1.0, " (m/s)", 0.3048);
        is("autodesk.spec.aec.piping:velocity-2.0.0", 10.0, " (m/s)", 3.048);
        is("autodesk.spec.aec:speed-2.0.0", 1.0, " (m/s)", 0.3048);
    }

    #[test]
    fn les_pressions() {
        // 1 kg/(pi·s²) = 1/0,3048 kg/(m·s²) = 3,280839895 Pa.
        is("autodesk.spec.aec.hvac:pressure-2.0.0", 1.0, " (Pa)", 3.280839895);
        is("autodesk.spec.aec.piping:pressure-2.0.0", 0.3048, " (Pa)", 1.0);
        // La bouche de soufflage du fichier DuctSegmentFlow : 4,27015 enregistré, 14,0097 Pa.
        is("autodesk.spec.aec.hvac:pressure-1.0.0", 4.27015, " (Pa)", 14.00967848);
        // 1 kg/(pi²·s²) par mètre : 1/0,09290304 = 10,76391042 Pa/m.
        is("autodesk.spec.aec.hvac:friction-2.0.0", 1.0, " (Pa/m)", 10.76391042);
        is("autodesk.spec.aec.hvac:viscosity-2.0.0", 0.3048, " (Pa·s)", 1.0);
    }

    #[test]
    fn les_temperatures() {
        // Le kelvin devient un degré Celsius ; l'écart de température reste en kelvin.
        is("autodesk.spec.aec.hvac:temperature-2.0.0", 293.15, " (°C)", 20.0);
        is("autodesk.spec.aec.piping:temperature-2.0.0", 373.15, " (°C)", 100.0);
        is("autodesk.spec.aec.electrical:temperature-2.0.0", 273.15 + 0.5, " (°C)", 0.5);
        is("autodesk.spec.aec.hvac:temperatureDifference-2.0.0", 12.0, " (K)", 12.0);
        is("autodesk.spec.aec.electrical:colorTemperature-2.0.0", 3000.0, " (K)", 3000.0);
    }

    #[test]
    fn l_electricite() {
        // 1 kg·pi²/s³ = 0,09290304 W : 10,76391042 enregistrés valent 1 W (donc 100 W s'enregistrent 1076,391).
        is("autodesk.spec.aec.electrical:power-2.0.0", 1.0, " (W)", 0.09290304);
        is("autodesk.spec.aec.electrical:power-2.0.0", 1076.391041670972, " (W)", 100.0);
        is("autodesk.spec.aec.hvac:power-2.0.0", 10.0, " (W)", 0.9290304);
        is("autodesk.spec.aec.hvac:heatGain-2.0.0", 1.0, " (W)", 0.09290304);
        is("autodesk.spec.aec.hvac:coolingLoad-2.0.0", 1.0, " (W)", 0.09290304);
        is("autodesk.spec.aec.hvac:heatingLoad-2.0.0", 1.0, " (W)", 0.09290304);
        is("autodesk.spec.aec.electrical:apparentPower-2.0.0", 1.0, " (VA)", 0.09290304);
        is("autodesk.spec.aec.electrical:apparentPower-1.0.0", 10763.91041670972, " (VA)", 1000.0);
        // Une tension : kg·pi²/(s³·A), 120 V s'enregistrent 1291,669 (120 / 0,09290304).
        is("autodesk.spec.aec.electrical:potential-2.0.0", 1.0, " (V)", 0.09290304);
        is("autodesk.spec.aec.electrical:potential-1.0.0", 1291.6692500051664, " (V)", 120.0);
        // Un courant en ampères, une fréquence en hertz : rien à convertir.
        is("autodesk.spec.aec.electrical:current-2.0.0", 16.0, " (A)", 16.0);
        is("autodesk.spec.aec.electrical:frequency-1.0.0", 50.0, " (Hz)", 50.0);
        // Une puissance par surface : kg·pi²/s³ par pi², donc des W/m² sans facteur.
        is("autodesk.spec.aec.electrical:powerDensity-2.0.0", 12.5, " (W/m²)", 12.5);
        is("autodesk.spec.aec.hvac:coolingLoadDividedByArea-2.0.0", 3.0, " (W/m²)", 3.0);
        // L'inverse : une surface par puissance, des pi² par kg·pi²/s³, donc des s³/kg = m²/W, sans facteur non plus.
        is("autodesk.spec.aec.hvac:areaDividedByCoolingLoad-2.0.0", 0.5, " (m²/W)", 0.5);
        is("autodesk.spec.aec.hvac:areaDividedByHeatingLoad-2.0.0", 1.25, " (m²/W)", 1.25);
        // Un éclairement : 1 lm/pi² (un foot-candle) = 10,76391042 lx ; une luminance, de même en cd/m².
        is("autodesk.spec.aec.electrical:illuminance-2.0.0", 1.0, " (lx)", 10.76391042);
        is("autodesk.spec.aec.electrical:luminance-2.0.0", 0.5, " (cd/m²)", 5.38195521);
        // Un flux lumineux en lumens, une intensité en candelas.
        is("autodesk.spec.aec.electrical:luminousFlux-2.0.0", 800.0, " (lm)", 800.0);
        is("autodesk.spec.aec.electrical:luminousIntensity-2.0.0", 120.0, " (cd)", 120.0);
        // Une efficacité lumineuse : lm par kg·pi²/s³, 1 vaut 10,76391042 lm/W.
        is("autodesk.spec.aec.electrical:efficacy-2.0.0", 1.0, " (lm/W)", 10.76391042);
    }

    #[test]
    fn les_masses_et_les_efforts() {
        is("autodesk.spec.aec.structural:mass-2.0.0", 2.5, " (kg)", 2.5);
        is("autodesk.spec.aec.piping:mass-2.0.0", 4.0, " (kg)", 4.0);
        // 1 kg/pi³ = 35,31466672 kg/m³ ; 1 kg/pi = 3,280839895 kg/m ; 1 kg/pi² = 10,76391042 kg/m².
        is("autodesk.spec.aec.hvac:density-2.0.0", 1.0, " (kg/m³)", 35.31466672);
        is("autodesk.spec.aec:massDensity-2.0.0", 0.028316846592, " (kg/m³)", 1.0);
        is("autodesk.spec.aec.structural:massPerUnitLength-2.0.0", 1.0, " (kg/m)", 3.280839895);
        is("autodesk.spec.aec.structural:massPerUnitArea-2.0.0", 1.0, " (kg/m²)", 10.76391042);
        // 1 kg·pi/s² = 0,3048 N ; un moment, kg·pi²/s² : 0,09290304 N·m ; un effort linéique, kg/s² : 1 N/m.
        is("autodesk.spec.aec.structural:force-2.0.0", 1.0, " (N)", 0.3048);
        is("autodesk.spec.aec.structural:moment-2.0.0", 1.0, " (N·m)", 0.09290304);
        is("autodesk.spec.aec.structural:linearForce-2.0.0", 7.0, " (N/m)", 7.0);
        is("autodesk.spec.aec.structural:areaForce-2.0.0", 1.0, " (N/m²)", 3.280839895);
        is("autodesk.spec.aec.structural:stress-2.0.0", 0.3048, " (Pa)", 1.0);
        is("autodesk.spec.aec.structural:linearMoment-2.0.0", 1.0, " (N)", 0.3048);
        is("autodesk.spec.aec.structural:energy-2.0.0", 1.0, " (J)", 0.09290304);
        is("autodesk.spec.aec.structural:acceleration-2.0.0", 1.0, " (m/s²)", 0.3048);
        is("autodesk.spec.aec.structural:momentOfInertia-2.0.0", 1.0, " (m⁴)", 0.008630974841);
        is("autodesk.spec.aec.structural:sectionModulus-2.0.0", 1.0, " (m³)", 0.028316846592);
        is("autodesk.spec.aec:time-2.0.0", 3600.0, " (s)", 3600.0);
    }

    #[test]
    fn les_pentes() {
        // Le rapport de la montée à la course : 0,01 est une pente de 1 %, 0,5 (6 pour 12) de 50 %.
        is("autodesk.spec.aec:slope-2.0.0", 0.01, " (%)", 1.0);
        is("autodesk.spec.aec.piping:slope-2.0.0", 0.5, " (%)", 50.0);
        is("autodesk.spec.aec.hvac:slope-2.0.0", 0.0208, " (%)", 2.08);
    }

    #[test]
    fn un_nombre_sans_dimension_reste_tel_quel_et_une_grandeur_inconnue_aussi() {
        assert_eq!(of_spec("autodesk.spec.aec:number-2.0.0"), Spec::Plain);
        assert_eq!(of_spec("autodesk.spec.aec.hvac:factor-2.0.0"), Spec::Plain);
        assert_eq!(of_spec("autodesk.spec.aec.electrical:demandFactor-1.0.0"), Spec::Plain);
        // Une conductivité thermique, un poids, un coût : l'unité interne n'est pas établie, aucune conversion.
        assert_eq!(of_spec("autodesk.spec.aec.energy:thermalConductivity-2.0.0"), Spec::Unknown);
        assert_eq!(of_spec("autodesk.spec.aec.structural:weight-2.0.0"), Spec::Unknown);
        assert_eq!(of_spec("autodesk.spec.measurable:currency-2.0.0"), Spec::Unknown);
        assert_eq!(of_spec("quelque chose d'inconnu"), Spec::Unknown);
    }
}
