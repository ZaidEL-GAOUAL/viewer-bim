//! Écriture du JSON de métadonnées : à la main, pour garder l'ordre des propriétés (le contrat veut les
//! propriétés « de tête » avant les groupes) et ne pas construire d'arbre de valeurs pour des dizaines
//! de milliers d'éléments.

use std::fmt::Write;

/// Une valeur de propriété.
#[derive(Debug, Clone, PartialEq)]
pub enum Val {
    Text(String),
    Int(i64),
    Num(f64),
    Bool(bool),
    List(Vec<String>),
}

/// Chiffres significatifs d'un nombre écrit dans le JSON. Douze : le bruit d'un produit par 0,3048 (le facteur
/// pied-mètre, de l'ordre du seizième chiffre) disparaît, et une valeur de Revit garde sa précision réelle (un numéro
/// 20231015, un coût 1234567.89, une coordonnée de relevé 652345.678 m). Six, comme avant, rognait ces valeurs ; l'affichage
/// du libellé des couches (`fiche`) reste à six.
pub const NUMBER_DIGITS: i32 = 12;

/// Arrondit à `digits` chiffres significatifs, en gardant la valeur décimale la plus courte : 0,3048
/// reste 0,3048 et non 0,30480000000000004.
pub fn round_significant(x: f64, digits: i32) -> f64 {
    if x == 0.0 || !x.is_finite() {
        return x;
    }
    let exponent = x.abs().log10().floor() as i32;
    let shift = digits - 1 - exponent;
    if shift.abs() > 300 {
        return x;
    }
    if shift >= 0 {
        let scale = 10f64.powi(shift);
        (x * scale).round() / scale
    } else {
        let scale = 10f64.powi(-shift);
        (x / scale).round() * scale
    }
}

/// Écrit `text` en chaîne JSON.
pub fn push_str(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

fn push_num(out: &mut String, x: f64) {
    if x.is_finite() {
        let _ = write!(out, "{x}");
    } else {
        out.push_str("null");
    }
}

impl Val {
    pub fn write(&self, out: &mut String) {
        match self {
            Val::Text(text) => push_str(out, text),
            Val::Int(n) => {
                let _ = write!(out, "{n}");
            }
            Val::Num(x) => push_num(out, round_significant(*x, NUMBER_DIGITS)),
            Val::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Val::List(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    push_str(out, item);
                }
                out.push(']');
            }
        }
    }
}

/// Un nom de propriété : le viewer sépare les catégories par « / » entouré d'espaces.
pub fn property_name(name: &str) -> String {
    name.replace(" / ", " - ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrondit_a_six_chiffres_significatifs() {
        assert_eq!(round_significant(0.304_800_000_000_000_04, 6), 0.3048);
        assert_eq!(round_significant(6.096_000_000_000_001, 6), 6.096);
        assert_eq!(round_significant(123_456.789, 6), 123_457.0);
        assert_eq!(round_significant(-0.666_666_666_666_666_6 * 0.3048, 6), -0.203_2);
        assert_eq!(round_significant(0.0, 6), 0.0);
    }

    #[test]
    fn un_nombre_garde_douze_chiffres_significatifs_dans_le_json() {
        let written = |x: f64| {
            let mut out = String::new();
            Val::Num(x).write(&mut out);
            out
        };
        // Les valeurs brutes de Revit ne sont plus rognées à six chiffres.
        assert_eq!(written(20_231_015.0), "20231015");
        assert_eq!(written(1_234_567.89), "1234567.89");
        assert_eq!(written(652_345.678), "652345.678");
        assert_eq!(written(-98_765.432_1), "-98765.4321");
        // Le bruit du produit par 0,3048 (de l'ordre du seizième chiffre) s'en va.
        assert_eq!(written(20.0 * 0.304_8), "6.096");
        assert_eq!(written(0.3048 * 3.0), "0.9144");
        assert_eq!(written(235.974_052_184_3 * 1.000_000_000_000_1), "235.974052184");
        assert_eq!(written(0.0), "0");
        assert_eq!(written(f64::NAN), "null");
        assert_eq!(written(1e-9), "0.000000001");
    }

    #[test]
    fn echappe_les_chaines() {
        let mut out = String::new();
        push_str(&mut out, "a\"b\\c\nd");
        assert_eq!(out, r#""a\"b\\c\nd""#);
    }
}
